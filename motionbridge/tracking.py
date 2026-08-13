from __future__ import annotations

import math
import time
import uuid
from dataclasses import dataclass, field

from .models import PersonPose


@dataclass
class Detection:
    person: PersonPose
    center: tuple[float, float]
    scale: float


@dataclass
class Track:
    id: str
    center: tuple[float, float]
    velocity: tuple[float, float] = (0.0, 0.0)
    scale: float = 0.2
    last_seen: float = field(default_factory=time.monotonic)
    person: PersonPose | None = None
    uncertain: bool = False


class MultiPersonTracker:
    """Conservative two-person tracker: uncertainty produces neutral output, never a swap."""

    def __init__(self, join_duration: float = 3.0) -> None:
        self.join_duration = join_duration
        self.tracks: dict[str, Track] = {}
        self.slot_track: list[str | None] = [None, None]
        self.join_requests: dict[int, tuple[float, str | None]] = {}
        self.needs_rejoin = [False, False]
        self.auto_rejoin: dict[int, tuple[tuple[float, float], float]] = {}
        self.last_unassigned = 0

    @staticmethod
    def describe(person: PersonPose) -> Detection:
        left_hip, right_hip = person.pose[23], person.pose[24]
        left_shoulder, right_shoulder = person.pose[11], person.pose[12]
        center = ((left_hip.x + right_hip.x) / 2, (left_hip.y + right_hip.y) / 2)
        shoulder = math.hypot(left_shoulder.x - right_shoulder.x, left_shoulder.y - right_shoulder.y)
        torso = math.hypot(
            (left_shoulder.x + right_shoulder.x) / 2 - center[0],
            (left_shoulder.y + right_shoulder.y) / 2 - center[1],
        )
        return Detection(person, center, max(0.08, shoulder, torso))

    def request_join(self, slot: int, now: float | None = None) -> None:
        self.slot_track[slot] = None
        self.needs_rejoin[slot] = False
        self.auto_rejoin.pop(slot, None)
        self.join_requests[slot] = (now if now is not None else time.monotonic(), None)

    def leave_slot(self, slot: int) -> None:
        self.slot_track[slot] = None
        self.needs_rejoin[slot] = False
        self.join_requests.pop(slot, None)
        self.auto_rejoin.pop(slot, None)

    def cancel_join(self, slot: int) -> None:
        self.join_requests.pop(slot, None)

    def assign_legacy(self, person: PersonPose, now: float | None = None) -> dict[int, PersonPose]:
        current = now if now is not None else time.monotonic()
        track_id = self.slot_track[0] or "legacy-player-1"
        detection = self.describe(person)
        self.slot_track[0] = track_id
        self.tracks[track_id] = Track(track_id, detection.center, scale=detection.scale, last_seen=current, person=person)
        return {0: person}

    def update(self, people: list[PersonPose], now: float | None = None) -> dict[int, PersonPose]:
        current = now if now is not None else time.monotonic()
        detections = [self.describe(person) for person in people[:2]]
        for track in self.tracks.values():
            track.uncertain = False
            track.person = None

        live_tracks = [track for track in self.tracks.values() if current - track.last_seen <= 2.0]
        pairs: list[tuple[float, Track, Detection]] = []
        for track in live_tracks:
            dt = min(0.5, max(0.0, current - track.last_seen))
            predicted = (track.center[0] + track.velocity[0] * dt, track.center[1] + track.velocity[1] * dt)
            for detection in detections:
                distance = math.hypot(predicted[0] - detection.center[0], predicted[1] - detection.center[1])
                scale_penalty = abs(math.log(max(detection.scale, 1e-3) / max(track.scale, 1e-3))) * 0.15
                pairs.append((distance / max(track.scale, detection.scale, 0.1) + scale_penalty, track, detection))

        # If the two possible identities are similarly plausible during a crossing,
        # suspend both assigned players rather than choosing and possibly swapping them.
        assigned_live = [track for track in live_tracks if track.id in self.slot_track]
        if len(assigned_live) == 2 and len(detections) == 2:
            a, b = assigned_live
            d0, d1 = detections
            direct = self._cost(a, d0, current) + self._cost(b, d1, current)
            swapped = self._cost(a, d1, current) + self._cost(b, d0, current)
            centers_close = math.hypot(d0.center[0] - d1.center[0], d0.center[1] - d1.center[1]) < max(d0.scale, d1.scale) * 0.7
            if centers_close or abs(direct - swapped) < 0.35:
                a.uncertain = b.uncertain = True
                self._expire(current)
                self.last_unassigned = len(detections)
                return {}

        used_tracks: set[str] = set()
        used_detections: set[int] = set()
        for cost, track, detection in sorted(pairs, key=lambda item: item[0]):
            index = detections.index(detection)
            if track.id in used_tracks or index in used_detections or cost > 2.2:
                continue
            dt = max(1 / 120, current - track.last_seen)
            velocity = ((detection.center[0] - track.center[0]) / dt, (detection.center[1] - track.center[1]) / dt)
            track.velocity = (track.velocity[0] * 0.55 + velocity[0] * 0.45, track.velocity[1] * 0.55 + velocity[1] * 0.45)
            track.center = detection.center
            track.scale = track.scale * 0.65 + detection.scale * 0.35
            track.last_seen = current
            track.person = detection.person
            used_tracks.add(track.id)
            used_detections.add(index)

        for index, detection in enumerate(detections):
            if index in used_detections:
                continue
            track_id = detection.person.detection_id or f"track-{uuid.uuid4().hex[:10]}"
            while track_id in self.tracks:
                track_id = f"track-{uuid.uuid4().hex[:10]}"
            self.tracks[track_id] = Track(track_id, detection.center, scale=detection.scale, last_seen=current, person=detection.person)

        self._progress_auto_rejoins()
        self._progress_joins(current)
        self._expire(current)
        result: dict[int, PersonPose] = {}
        assigned_ids = {track_id for track_id in self.slot_track if track_id}
        self.last_unassigned = sum(1 for track in self.tracks.values() if track.person is not None and track.id not in assigned_ids)
        for slot, track_id in enumerate(self.slot_track):
            track = self.tracks.get(track_id or "")
            if track and track.person is not None and not track.uncertain:
                result[slot] = track.person
        return result

    def _progress_joins(self, now: float) -> None:
        assigned = {track_id for track_id in self.slot_track if track_id}
        available = [track for track in self.tracks.values() if track.person is not None and track.id not in assigned]
        for slot, (started, candidate_id) in list(self.join_requests.items()):
            candidate = self.tracks.get(candidate_id or "")
            if candidate is None or candidate.person is None:
                if not available:
                    self.join_requests[slot] = (now, None)
                    continue
                # Stable left-to-right selection makes two simultaneous join flows predictable.
                candidate = sorted(available, key=lambda item: item.center[0])[0]
                self.join_requests[slot] = (now, candidate.id)
                continue
            if now - started >= self.join_duration:
                self.slot_track[slot] = candidate.id
                self.join_requests.pop(slot, None)
                assigned.add(candidate.id)
                available = [track for track in available if track.id != candidate.id]

    def _progress_auto_rejoins(self) -> None:
        assigned = {track_id for track_id in self.slot_track if track_id}
        available = [track for track in self.tracks.values() if track.person is not None and track.id not in assigned]
        for slot, (center, scale) in list(self.auto_rejoin.items()):
            if slot in self.join_requests or self.slot_track[slot] is not None or not available:
                continue
            ranked = sorted(available, key=lambda track: math.hypot(track.center[0] - center[0], track.center[1] - center[1]) / max(scale, track.scale, 0.1))
            candidate = ranked[0]
            cost = math.hypot(candidate.center[0] - center[0], candidate.center[1] - center[1]) / max(scale, candidate.scale, 0.1)
            if cost <= 2.5 or len(available) == 1:
                self.slot_track[slot] = candidate.id
                self.needs_rejoin[slot] = False
                self.auto_rejoin.pop(slot, None)
                available.remove(candidate)

    def _expire(self, now: float) -> None:
        expired = [track_id for track_id, track in self.tracks.items() if now - track.last_seen > 2.0]
        for track_id in expired:
            track = self.tracks.pop(track_id, None)
            for slot, assigned in enumerate(self.slot_track):
                if assigned == track_id and track is not None:
                    self.auto_rejoin[slot] = (track.center, track.scale)
                    self.slot_track[slot] = None
                    self.needs_rejoin[slot] = False

    @staticmethod
    def _cost(track: Track, detection: Detection, now: float) -> float:
        dt = min(0.5, max(0.0, now - track.last_seen))
        predicted = (track.center[0] + track.velocity[0] * dt, track.center[1] + track.velocity[1] * dt)
        return math.hypot(predicted[0] - detection.center[0], predicted[1] - detection.center[1]) / max(track.scale, detection.scale, 0.1)

    def slot_status(self, slot: int, now: float | None = None) -> dict[str, object]:
        current = now if now is not None else time.monotonic()
        track_id = self.slot_track[slot]
        track = self.tracks.get(track_id or "")
        join = self.join_requests.get(slot)
        if join:
            return {
                "state": "joining", "track_id": join[1],
                "countdown_ms": max(0, round((self.join_duration - (current - join[0])) * 1000)),
            }
        if track is None:
            state = "auto_rejoining" if slot in self.auto_rejoin else ("needs_rejoin" if self.needs_rejoin[slot] else "unassigned")
            return {"state": state, "track_id": None, "countdown_ms": 0}
        age_ms = round((current - track.last_seen) * 1000)
        if track.uncertain:
            state = "uncertain"
        elif age_ms > 300:
            state = "missing"
        else:
            state = "tracking"
        return {"state": state, "track_id": track.id, "age_ms": age_ms, "countdown_ms": 0}

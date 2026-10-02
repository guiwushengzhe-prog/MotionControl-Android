package cn.motioncontrol.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeSessionGateTest {
    @Test
    public void lateModelCompletionCannotInstallAfterStop() {
        NativeSessionGate gate = new NativeSessionGate();
        long downloading = gate.begin();
        gate.cancel();
        assertFalse(gate.isCurrent(downloading));
        assertTrue(gate.isCurrent(gate.begin()));
    }

    @Test
    public void returningToForegroundDoesNotReviveOldPermissionCallback() {
        NativeSessionGate gate = new NativeSessionGate();
        long awaitingPermission = gate.begin();
        gate.pause();
        assertFalse(gate.isCurrent(awaitingPermission));
        gate.resume();
        assertFalse(gate.isCurrent(awaitingPermission));
        assertTrue(gate.isCurrent(gate.begin()));
    }

    @Test
    public void permissionDialogCannotStartMicrophoneUntilActivityResumes() {
        NativeSessionGate gate = new NativeSessionGate();
        long awaitingPermission = gate.begin();
        gate.suspend();
        assertFalse(gate.isCurrent(awaitingPermission));
        assertTrue(gate.isGeneration(awaitingPermission));
        gate.resume();
        assertTrue(gate.isCurrent(awaitingPermission));
    }

    @Test
    public void replacementAndDestructionInvalidateAllOldCallbacks() {
        NativeSessionGate gate = new NativeSessionGate();
        long old = gate.begin();
        long replacement = gate.begin();
        assertFalse(gate.isCurrent(old));
        assertTrue(gate.isCurrent(replacement));
        gate.destroy();
        gate.resume();
        assertFalse(gate.isCurrent(replacement));
        assertFalse(gate.isCurrent(gate.begin()));
    }
}

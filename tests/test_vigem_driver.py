from pathlib import Path
from types import SimpleNamespace

import pytest

from motionbridge import vigem_driver


def test_service_state_detects_running() -> None:
    def runner(*args, **kwargs):
        return SimpleNamespace(returncode=0, stdout="SERVICE_NAME: ViGEmBus\nSTATE : 4 RUNNING", stderr="")

    assert vigem_driver.service_state(runner) == {"installed": True, "running": True, "error": None}


def test_launch_installer_uses_runas_and_exact_hash(tmp_path: Path) -> None:
    installer = tmp_path / vigem_driver.INSTALLER_NAME
    installer.write_bytes(b"signed-official-installer-fixture")
    expected = vigem_driver.INSTALLER_SHA256
    vigem_driver.INSTALLER_SHA256 = vigem_driver.sha256_file(installer)
    calls = []
    try:
        result = vigem_driver.launch_installer(tmp_path, lambda *args: calls.append(args) or 42)
    finally:
        vigem_driver.INSTALLER_SHA256 = expected
    assert result["launched"] is True
    assert calls[0][1] == "runas"
    assert calls[0][2] == str(installer)


def test_launch_installer_rejects_hash_mismatch(tmp_path: Path) -> None:
    (tmp_path / vigem_driver.INSTALLER_NAME).write_bytes(b"tampered")
    with pytest.raises(ValueError, match="校验失败"):
        vigem_driver.launch_installer(tmp_path, lambda *args: 42)

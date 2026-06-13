import os
import pytest
import federation_config as fc


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    path = tmp_path / "federation.json"
    monkeypatch.setenv("PROXMENUX_FEDERATION_CONFIG", str(path))
    return path


def test_load_empty_when_no_file(cfg):
    assert fc.load_peers() == []


def test_add_and_get_peer(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "port": 8008, "token": "abc"})
    peers = fc.load_peers()
    assert len(peers) == 1
    assert peers[0]["name"] == "pve2"
    assert peers[0]["enabled"] is True
    assert fc.get_peer("pve2")["host"] == "pve2.lan"


def test_file_has_0600_perms(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc"})
    assert oct(os.stat(cfg).st_mode & 0o777) == "0o600"


def test_reject_duplicate_name(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc"})
    with pytest.raises(ValueError):
        fc.add_peer({"name": "pve2", "host": "other.lan", "token": "xyz"})


def test_missing_token_rejected(cfg):
    with pytest.raises(ValueError):
        fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": ""})


def test_invalid_port_rejected(cfg):
    with pytest.raises(ValueError):
        fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc", "port": 99999})


def test_remove_peer(cfg):
    fc.add_peer({"name": "pve2", "host": "pve2.lan", "token": "abc"})
    assert fc.remove_peer("pve2") is True
    assert fc.load_peers() == []
    assert fc.remove_peer("nope") is False

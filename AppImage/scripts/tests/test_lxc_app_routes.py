import pytest
from flask import Flask
import flask_lxc_app_routes as routes


@pytest.fixture
def client(monkeypatch):
    app = Flask(__name__)
    app.register_blueprint(routes.lxc_app_bp)
    return app.test_client()


def test_catalog_endpoint(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "catalog_list",
                        lambda: [{"id": "jellyfin", "name": "Jellyfin"}])
    body = client.get("/api/lxc-app-catalog").get_json()
    assert body["apps"][0]["id"] == "jellyfin"


def test_assign_validation_error(client, monkeypatch):
    def boom(vmid, data):
        raise ValueError("app_id is required")
    monkeypatch.setattr(routes.lau, "set_assignment", boom)
    r = client.post("/api/vms/101/app", json={})
    assert r.status_code == 400
    assert "app_id" in r.get_json()["error"]


def test_assign_ok_runs_check(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "set_assignment",
                        lambda vmid, data: {"app_id": "jellyfin"})
    monkeypatch.setattr(routes.lau, "check_lxc_app",
                        lambda vmid, store=True: {"installed": "1.0", "latest": "1.1",
                                                  "update_available": True})
    body = client.post("/api/vms/101/app", json={"app_id": "jellyfin"}).get_json()
    assert body["success"] is True
    assert body["app_update"]["update_available"] is True


def test_delete_assignment(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "clear_assignment", lambda vmid: True)
    assert client.delete("/api/vms/101/app").status_code == 200


def test_check_no_assignment_404(client, monkeypatch):
    monkeypatch.setattr(routes.lau, "check_lxc_app", lambda vmid, store=True: None)
    assert client.post("/api/vms/101/app/check").status_code == 404


def test_settings_set(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(routes.lau, "set_github_pat",
                        lambda pat: captured.update(pat=pat))
    monkeypatch.setattr(routes.lau, "get_settings",
                        lambda: {"github_pat_configured": True})
    body = client.post("/api/lxc-app/settings", json={"github_pat": "ghp_x"}).get_json()
    assert captured["pat"] == "ghp_x"
    assert body["github_pat_configured"] is True

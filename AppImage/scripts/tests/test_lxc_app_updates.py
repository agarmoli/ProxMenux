import json
import os
import pytest
import lxc_app_updates as lau


@pytest.fixture
def env(tmp_path, monkeypatch):
    cat = tmp_path / "cat.json"
    cat.write_text(json.dumps({"version": 1, "apps": [
        {"id": "jellyfin", "name": "Jellyfin", "repo": "jellyfin/jellyfin",
         "github_source": "releases", "tag_regex": r"v?(\d+\.\d+\.\d+)",
         "installed": {"method": "command", "value": "jellyfin --version", "regex": r"(\d+\.\d+\.\d+)"}}
    ]}))
    db = tmp_path / "db.json"
    monkeypatch.setenv("PROXMENUX_LXC_APP_CATALOG", str(cat))
    monkeypatch.setenv("PROXMENUX_LXC_APP_DB", str(db))
    lau._catalog_cache["apps"] = None  # reset memoization
    return db


def test_catalog_loads(env):
    apps = lau.load_catalog()
    assert "jellyfin" in apps
    assert lau.catalog_list()[0]["repo"] == "jellyfin/jellyfin"


def test_assignment_catalog_app(env):
    spec = lau.set_assignment(101, {"app_id": "jellyfin"})
    assert spec == {"app_id": "jellyfin"}
    assert lau.get_assignment(101) == {"app_id": "jellyfin"}


def test_assignment_unknown_app_rejected(env):
    with pytest.raises(ValueError):
        lau.set_assignment(101, {"app_id": "nope"})


def test_assignment_custom_validates_repo(env):
    with pytest.raises(ValueError):
        lau.set_assignment(101, {"app_id": "custom", "repo": "noslash",
                                 "installed": {"method": "file", "value": "/x"}})
    spec = lau.set_assignment(102, {"app_id": "custom", "repo": "o/r",
                                    "installed": {"method": "file", "value": "/x"}})
    assert spec["repo"] == "o/r" and spec["github_source"] == "releases"


def test_clear_assignment(env):
    lau.set_assignment(101, {"app_id": "jellyfin"})
    assert lau.clear_assignment(101) is True
    assert lau.get_assignment(101) is None
    assert lau.clear_assignment(101) is False


def test_db_file_is_0600(env):
    lau.set_github_pat("ghp_secret")
    assert oct(os.stat(env).st_mode & 0o777) == "0o600"
    assert lau.get_settings() == {"github_pat_configured": True}


def test_version_tuple_and_compare(env):
    assert lau._version_tuple("1.2.10") == (1, 2, 10)
    assert lau.compare("1.2.0", "1.3.0") == (True, False)
    assert lau.compare("1.3.0", "1.3.0") == (False, False)
    # numbers present on both sides -> numeric compare (e.g. "stable-22" -> 22)
    assert lau.compare("stable-22", "stable-23") == (True, False)
    # no extractable numbers -> string compare, flagged non-semver
    assert lau.compare("stable", "rolling") == (True, True)
    assert lau.compare("stable", "stable") == (False, True)


def test_extract_regex(env):
    assert lau._extract("Jellyfin 10.9.1 build", r"(\d+\.\d+\.\d+)") == "10.9.1"
    assert lau._extract("no version", r"(\d+\.\d+\.\d+)") is None


from unittest.mock import patch, MagicMock
import urllib.error


def test_read_installed_version_command(env):
    completed = MagicMock(returncode=0, stdout="Jellyfin 10.9.1\n", stderr="")
    with patch("lxc_app_updates.subprocess.run", return_value=completed):
        ver, err = lau.read_installed_version(
            101, {"method": "command", "value": "jellyfin --version", "regex": r"(\d+\.\d+\.\d+)"})
    assert ver == "10.9.1" and err is None


def test_read_installed_version_stopped(env):
    completed = MagicMock(returncode=2, stdout="", stderr="Container 101 is not running")
    with patch("lxc_app_updates.subprocess.run", return_value=completed):
        ver, err = lau.read_installed_version(
            101, {"method": "command", "value": "x", "regex": r"(\d+)"})
    assert ver is None and err == "container stopped"


def test_fetch_latest_releases(env):
    with patch("lxc_app_updates._gh_get", return_value={"tag_name": "v10.9.2"}):
        ver, err = lau.fetch_latest("o/r", "releases", r"v?(\d+\.\d+\.\d+)")
    assert ver == "10.9.2" and err is None


def test_fetch_latest_tags_first_match(env):
    tags = [{"name": "nightly"}, {"name": "v2.5.0"}, {"name": "v2.4.0"}]
    with patch("lxc_app_updates._gh_get", return_value=tags):
        ver, err = lau.fetch_latest("o/r", "tags", r"v(\d+\.\d+\.\d+)")
    assert ver == "2.5.0" and err is None


def test_fetch_latest_rate_limited(env):
    err = urllib.error.HTTPError("u", 403, "forbidden",
                                 {"X-RateLimit-Remaining": "0"}, None)
    with patch("lxc_app_updates._gh_get", side_effect=err):
        ver, e = lau.fetch_latest("o/r", "releases", r"(\d+)")
    assert ver is None and e == "github rate limited"


def test_fetch_latest_404(env):
    err = urllib.error.HTTPError("u", 404, "nf", {}, None)
    with patch("lxc_app_updates._gh_get", side_effect=err):
        ver, e = lau.fetch_latest("o/r", "releases", r"(\d+)")
    assert e == "repo or release not found"


def test_check_lxc_app_end_to_end(env):
    lau.set_assignment(101, {"app_id": "jellyfin"})
    completed = MagicMock(returncode=0, stdout="10.9.1", stderr="")
    with patch("lxc_app_updates.subprocess.run", return_value=completed), \
         patch("lxc_app_updates._gh_get", return_value={"tag_name": "v10.9.2"}):
        res = lau.check_lxc_app(101)
    assert res["installed"] == "10.9.1"
    assert res["latest"] == "10.9.2"
    assert res["update_available"] is True
    assert "101" in lau.get_app_update_map()

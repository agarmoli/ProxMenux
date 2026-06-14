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

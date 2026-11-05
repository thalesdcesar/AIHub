import os
import time
import pytest
import requests

def _base():
    url = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
    if not url:
        for line in open("/app/frontend/.env"):
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                url = line.split("=", 1)[1].strip()
    return url.rstrip("/")

BASE_URL = _base()
MAC, PIN = os.environ.get("TEST_MAC", "18:41:B9:44:28:D3"), os.environ.get("TEST_PIN", "798373")
AUTH = {"mac": MAC, "pin": PIN}


@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def summary(s):
    deadline = time.time() + 120
    while time.time() < deadline:
        r = s.get(f"{BASE_URL}/api/playlist/summary", params=AUTH, timeout=60)
        assert r.status_code == 200
        d = r.json()
        if d["state"] != "loading":
            return d
        time.sleep(3)
    pytest.fail("playlist never became ready")


# Device status
class TestDeviceStatus:
    def test_active(self, s):
        r = s.get(f"{BASE_URL}/api/device/status", params=AUTH, timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["state"] == "active"
        assert "link" not in d

    def test_active_lowercase_mac(self, s):
        r = s.get(f"{BASE_URL}/api/device/status", params={"mac": MAC.lower(), "pin": PIN}, timeout=30)
        assert r.json()["state"] == "active"

    def test_wrong_pin(self, s):
        r = s.get(f"{BASE_URL}/api/device/status", params={"mac": MAC, "pin": "000000"}, timeout=30)
        assert r.status_code == 200 and r.json()["state"] == "wrong_pin"

    def test_pending_unknown(self, s):
        r = s.get(f"{BASE_URL}/api/device/status", params={"mac": "00:11:22:33:44:99", "pin": "123456"}, timeout=30)
        assert r.status_code == 200 and r.json()["state"] == "pending"

    def test_validation(self, s):
        r = s.get(f"{BASE_URL}/api/device/status", params={"mac": "x", "pin": "1"}, timeout=30)
        assert r.status_code == 422
        r = s.get(f"{BASE_URL}/api/device/status", params={"mac": MAC}, timeout=30)
        assert r.status_code == 422


# Playlist summary
class TestSummary:
    def test_ready_counts(self, summary):
        assert summary["state"] == "ready"
        assert summary["total"] > 1000
        c = summary["counts"]
        assert set(c) == {"tv", "movies", "series", "music"}
        assert sum(c.values()) == summary["total"]
        for sec, gs in summary["groups"].items():
            assert sum(g["count"] for g in gs) == c[sec]

    def test_403_wrong_pin(self, s):
        r = s.get(f"{BASE_URL}/api/playlist/summary", params={"mac": MAC, "pin": "000000"}, timeout=30)
        assert r.status_code == 403 and r.json()["detail"] == "wrong_pin"

    def test_403_pending(self, s):
        r = s.get(f"{BASE_URL}/api/playlist/summary", params={"mac": "00:11:22:33:44:99", "pin": "1"}, timeout=30)
        assert r.status_code == 403 and r.json()["detail"] == "pending"


# Playlist channels
class TestChannels:
    def test_tv_page(self, s, summary):
        r = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "tv"}, timeout=30)
        d = r.json()
        assert r.status_code == 200 and d["state"] == "ready"
        assert d["total"] == summary["counts"]["tv"]
        assert len(d["items"]) == min(60, d["total"])
        it = d["items"][0]
        for k in ("id", "name", "logo", "group", "section", "url"):
            assert k in it
        assert it["section"] == "tv"

    def test_pagination(self, s, summary):
        p1 = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "movies", "limit": 50}, timeout=30).json()
        p2 = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "movies", "limit": 50, "offset": 50}, timeout=30).json()
        ids1 = {i["id"] for i in p1["items"]}
        ids2 = {i["id"] for i in p2["items"]}
        assert len(ids1) == 50 and len(ids2) == 50 and not ids1 & ids2
        assert p2["offset"] == 50

    def test_group_filter(self, s, summary):
        g = summary["groups"]["tv"][0]
        d = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "tv", "group": g["name"], "limit": 200}, timeout=30).json()
        assert d["total"] == g["count"]
        assert all(i["group"] == g["name"] for i in d["items"])

    def test_search(self, s, summary):
        d = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "tv", "q": "globo"}, timeout=30).json()
        assert all("globo" in i["name"].lower() for i in d["items"])
        none = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "tv", "q": "zzzqqqxx"}, timeout=30).json()
        assert none["total"] == 0 and none["items"] == []

    def test_invalid_section_and_limit(self, s):
        assert s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "bad"}, timeout=30).status_code == 400
        assert s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "limit": 500}, timeout=30).status_code == 422

    def test_channels_403(self, s):
        r = s.get(f"{BASE_URL}/api/playlist/channels", params={"mac": MAC, "pin": "000000"}, timeout=30)
        assert r.status_code == 403


# Device cache (30s) in active_playlist: repeated channel pages should be fast after first call
class TestDeviceCache:
    def test_cached_page_fast(self, s, summary):
        s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "tv"}, timeout=30)
        times = []
        for off in (0, 60, 120):
            t = time.time()
            r = s.get(f"{BASE_URL}/api/playlist/channels", params={**AUTH, "section": "tv", "offset": off}, timeout=30)
            times.append(time.time() - t)
            assert r.status_code == 200 and r.json()["offset"] == off
        print("cached page times", times)
        assert max(times) < 2.0

    def test_cache_not_shared_with_wrong_pin(self, s, summary):
        # warm cache with valid creds, wrong pin must still be 403 (different cache key)
        s.get(f"{BASE_URL}/api/playlist/summary", params=AUTH, timeout=30)
        r = s.get(f"{BASE_URL}/api/playlist/summary", params={"mac": MAC, "pin": "000000"}, timeout=30)
        assert r.status_code == 403
        r2 = s.get(f"{BASE_URL}/api/playlist/summary", params={"mac": MAC.lower(), "pin": PIN}, timeout=30)
        assert r2.status_code == 200 and r2.json()["state"] == "ready"

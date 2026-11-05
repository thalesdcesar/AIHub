import asyncio
import logging
import os
import re
import time
from datetime import datetime, timezone, date
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Query
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

FIREBASE_PROJECT_ID = os.environ['FIREBASE_PROJECT_ID']
FIREBASE_API_KEY = os.environ['FIREBASE_API_KEY']
FIRESTORE_QUERY_URL = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
    f"/databases/(default)/documents:runQuery?key={FIREBASE_API_KEY}"
)
PLAYLIST_TTL = 6 * 3600
MAX_CACHED_PLAYLISTS = 3
UA = "VLC/3.0.20 LibVLC/3.0.20"

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI()


@app.get("/health", include_in_schema=False)
@app.head("/health", include_in_schema=False)
async def health():
    return {"status": "ok"}


api_router = APIRouter(prefix="/api")

# ---------------------------------------------------------------- Firestore

def _field(fields: dict, *names: str) -> str:
    for n in names:
        v = fields.get(n)
        if not v:
            continue
        for k in ("stringValue", "integerValue", "doubleValue", "timestampValue"):
            if k in v:
                return str(v[k]).strip()
        if "booleanValue" in v:
            return "active" if v["booleanValue"] else "blocked"
    return ""


def _parse_date(value: str) -> Optional[date]:
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value[:10], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


async def find_device(mac: str) -> Optional[dict]:
    variants = list(dict.fromkeys([mac.upper(), mac.lower(), mac]))
    async with httpx.AsyncClient(timeout=15) as client:
        for v in variants:
            body = {"structuredQuery": {
                "from": [{"collectionId": "clientes"}],
                "where": {"fieldFilter": {"field": {"fieldPath": "mac"}, "op": "EQUAL",
                                          "value": {"stringValue": v}}},
                "limit": 1}}
            r = await client.post(FIRESTORE_QUERY_URL, json=body)
            r.raise_for_status()
            for row in r.json():
                doc = row.get("document")
                if doc:
                    f = doc.get("fields", {})
                    return {
                        "mac": _field(f, "mac").upper(),
                        "pin": _field(f, "senha", "pin"),
                        "link": _field(f, "link", "link_m3u", "playlistUrl"),
                        "status": _field(f, "status").lower(),
                        "expiry": _field(f, "validade", "expiryDate", "vencimento"),
                        "name": _field(f, "nome", "name"),
                    }
    return None


async def resolve_device(mac: str, pin: str) -> dict:
    """Returns dict with state: pending | wrong_pin | blocked | expired | no_list | active."""
    try:
        dev = await find_device(mac.strip())
    except Exception as exc:
        logger.error("firestore error: %s", exc)
        return {"state": "offline"}
    if not dev:
        return {"state": "pending"}
    expiry = _parse_date(dev["expiry"]) if dev["expiry"] else None
    base = {"expiry": expiry.isoformat() if expiry else None, "name": dev["name"] or None}
    if dev["pin"] and dev["pin"] != pin.strip():
        return {**base, "state": "wrong_pin"}
    if dev["status"] in ("blocked", "bloqueado", "inativo", "inactive"):
        return {**base, "state": "blocked"}
    if dev["status"] in ("expired", "expirado") or (expiry and expiry < date.today()):
        return {**base, "state": "expired"}
    if not dev["link"]:
        return {**base, "state": "no_list"}
    return {**base, "state": "active", "link": dev["link"]}


# ---------------------------------------------------------------- Playlist

SECTIONS = ("tv", "movies", "series", "music")
RE_LOGO = re.compile(r'tvg-logo="([^"]*)"', re.I)
RE_GROUP = re.compile(r'group-title="([^"]*)"', re.I)
RE_NAME = re.compile(r'tvg-name="([^"]*)"', re.I)
RE_EP = re.compile(r's\d{1,2}\s?e\d{1,3}|t\d{1,2}\s?e\d{1,3}|ep\.?\s?\d+|epis[oó]dio', re.I)
MUSIC_WORDS = ("radio", "rádio", "musica", "música", "music", "clipe", "hits")
VOD_EXT = (".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv", ".flv")


def classify(group: str, name: str, url: str) -> str:
    g, u = group.lower(), url.lower().split("?")[0]
    if any(w in g for w in MUSIC_WORDS) or re.search(r'\bfm\b', g):
        return "music"
    if "/series/" in u:
        return "series"
    if "/movie/" in u:
        return "movies"
    if u.endswith(VOD_EXT):
        if RE_EP.search(name) or any(w in g for w in ("serie", "série", "novela", "temporada", "anime", "dorama")):
            return "series"
        return "movies"
    return "tv"


class Playlist:
    def __init__(self, url: str):
        self.url = url
        self.state = "loading"
        self.error: Optional[str] = None
        self.loaded_at = 0.0
        self.channels: list[tuple] = []  # (name, logo, group, section, url)
        self.by_section: dict[str, list[int]] = {s: [] for s in SECTIONS}
        self.groups: dict[str, dict[str, list[int]]] = {s: {} for s in SECTIONS}
        self.progress = 0

    def parse(self, text: str):
        name = logo = group = None
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#EXTINF"):
                m = RE_LOGO.search(line)
                logo = m.group(1) if m else ""
                m = RE_GROUP.search(line)
                group = (m.group(1) if m else "").strip() or "Geral"
                idx = line.rfind('",')
                comma = line.rfind(",") if idx == -1 else idx + 1
                name = line[comma + 1:].strip() if comma != -1 else ""
                if not name:
                    m = RE_NAME.search(line)
                    name = m.group(1) if m else "Canal"
            elif line.startswith("#EXTGRP:") and name is not None:
                group = line[8:].strip() or group
            elif not line.startswith("#") and "://" in line:
                if name is None:
                    name, logo, group = f"Canal {len(self.channels) + 1}", "", "Geral"
                section = classify(group, name, line)
                i = len(self.channels)
                self.channels.append((name, logo, group, section, line))
                self.by_section[section].append(i)
                self.groups[section].setdefault(group, []).append(i)
                name = logo = group = None
                self.progress = i + 1


PLAYLISTS: dict[str, Playlist] = {}


async def _load(pl: Playlist):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=True,
                                     headers={"User-Agent": UA}) as client:
            r = await client.get(pl.url)
            r.raise_for_status()
            text = r.text
        await asyncio.to_thread(pl.parse, text)
        if not pl.channels:
            pl.state, pl.error = "error", "A lista não contém canais válidos."
        else:
            pl.state = "ready"
        pl.loaded_at = time.time()
        logger.info("playlist loaded %s items", len(pl.channels))
    except Exception as exc:
        logger.error("playlist load failed: %s", exc)
        pl.state, pl.error = "error", "Não foi possível baixar a lista do servidor IPTV."
        pl.loaded_at = time.time()


def get_playlist(url: str, force: bool = False) -> Playlist:
    pl = PLAYLISTS.get(url)
    expired = pl and pl.state != "loading" and (
        time.time() - pl.loaded_at > (PLAYLIST_TTL if pl.state == "ready" else 30))
    if pl is None or expired or (force and pl.state != "loading"):
        if len(PLAYLISTS) >= MAX_CACHED_PLAYLISTS and url not in PLAYLISTS:
            oldest = min(PLAYLISTS, key=lambda k: PLAYLISTS[k].loaded_at or time.time())
            PLAYLISTS.pop(oldest, None)
        pl = Playlist(url)
        PLAYLISTS[url] = pl
        asyncio.create_task(_load(pl))
    return pl


DEVICE_CACHE: dict[tuple, tuple[float, dict]] = {}


async def active_playlist(mac: str, pin: str, force: bool = False) -> Playlist:
    key = (mac.strip().upper(), pin.strip())
    hit = DEVICE_CACHE.get(key)
    if hit and time.time() - hit[0] < 30 and not force:
        dev = hit[1]
    else:
        dev = await resolve_device(mac, pin)
        DEVICE_CACHE[key] = (time.time(), dev)
    if dev["state"] != "active":
        raise HTTPException(status_code=403, detail=dev["state"])
    return get_playlist(dev["link"], force)


# ---------------------------------------------------------------- Routes

@api_router.get("/")
async def root():
    return {"message": "IPTV API"}


@api_router.get("/device/status")
async def device_status(mac: str = Query(..., min_length=11, max_length=17), pin: str = Query(..., min_length=1)):
    dev = await resolve_device(mac, pin)
    dev.pop("link", None)
    return dev


@api_router.get("/playlist/summary")
async def playlist_summary(mac: str, pin: str, refresh: bool = False):
    pl = await active_playlist(mac, pin, refresh)
    if pl.state != "ready":
        return {"state": pl.state, "error": pl.error, "progress": pl.progress}
    return {
        "state": "ready",
        "total": len(pl.channels),
        "counts": {s: len(pl.by_section[s]) for s in SECTIONS},
        "groups": {s: [{"name": g, "count": len(ix)} for g, ix in pl.groups[s].items()] for s in SECTIONS},
    }


@api_router.get("/playlist/channels")
async def playlist_channels(mac: str, pin: str, section: str = "tv", group: Optional[str] = None,
                            q: Optional[str] = None, offset: int = Query(0, ge=0),
                            limit: int = Query(60, ge=1, le=200)):
    if section not in SECTIONS:
        raise HTTPException(status_code=400, detail="invalid section")
    pl = await active_playlist(mac, pin)
    if pl.state != "ready":
        return {"state": pl.state, "items": [], "total": 0}
    ids = pl.groups[section].get(group, []) if group else pl.by_section[section]
    if q and q.strip():
        needle = q.strip().lower()
        ids = [i for i in ids if needle in pl.channels[i][0].lower()]
    page = ids[offset:offset + limit]
    items = [{"id": i, "name": c[0], "logo": c[1] or None, "group": c[2], "section": c[3], "url": c[4]}
             for i in page for c in [pl.channels[i]]]
    return {"state": "ready", "items": items, "total": len(ids), "offset": offset}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

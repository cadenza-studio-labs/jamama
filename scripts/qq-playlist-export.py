#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


DEFAULT_DATABASE = Path.home() / "Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac/qqmusic.sqlite"
MAX_TRACKS = 1000
MAX_PLAYLISTS = 20
MAX_BYTES = 1024 * 1024
MAX_ID = 9007199254740991


class ExportError(Exception):
    pass


def readable_text(value, maximum):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > maximum or re.search(r"[\x00-\x1f\x7f]", value):
        return None
    return value


def display_name(value):
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "Unnamed playlist"))[:120]


def connect_readonly(path):
    database = sqlite3.connect(Path(path).expanduser().resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    try:
        database.row_factory = sqlite3.Row
        database.execute("PRAGMA query_only=ON")
        database.execute("BEGIN")
        return database
    except sqlite3.Error:
        database.close()
        raise


def account_for(database):
    rows = database.execute("SELECT DISTINCT uin FROM NEWFOLDERS WHERE uin <> 0").fetchall()
    if len(rows) > 1:
        raise ExportError("QQ Music has cached several accounts. Open the account you want in QQ Music; this helper cannot safely choose its library.")
    if not rows:
        raise ExportError("QQ Music has no cached playlists. Open your playlists in the QQ Music Mac app, then try again.")
    return rows[0]["uin"]


def playlist_rows(database, account):
    columns = {row["name"] for row in database.execute("PRAGMA table_info(NEWFOLDERS)")}
    order = "f.K_USER_FOLDER_ORDER, f.seq" if "K_USER_FOLDER_ORDER" in columns else "f.seq"
    rows = database.execute(f"""
        SELECT f.seq AS id, f.folderName AS name,
          (SELECT COUNT(DISTINCT s.id) FROM NEWFOLDERSONGS fs
           JOIN SONGS s ON s.id = fs.id AND s.type = fs.type
           WHERE fs.seq = f.seq AND fs.opType = 0) AS trackCount
        FROM NEWFOLDERS f WHERE f.uin = ? ORDER BY {order}
    """, (account,)).fetchall()
    return [{"id": str(row["id"]), "name": display_name(row["name"]), "trackCount": row["trackCount"]} for row in rows]


def read_playlists(path, with_account=False):
    database = connect_readonly(path)
    try:
        account = account_for(database)
        playlists = playlist_rows(database, account)
        return (playlists, hashlib.sha256(str(account).encode()).digest()) if with_account else playlists
    finally:
        database.close()


def parse_selection(value, count):
    if not isinstance(value, str) or len(value) > 200:
        raise ExportError("Choose up to 20 playlist numbers from the list shown above.")
    parts = [part.strip() for part in value.split(",")]
    if not parts or any(not re.fullmatch(r"[1-9]\d*(?:\s*-\s*[1-9]\d*)?", part) for part in parts):
        raise ExportError("Choose playlist numbers, such as 1 or 1,3 or 2-4. Enter q to cancel.")
    selected = []
    for part in parts:
        bounds = [int(number.strip()) for number in part.split("-")]
        first, last = bounds[0], bounds[-1]
        if first > last or first < 1 or last > count:
            raise ExportError("Choose numbers from the playlist list shown above.")
        if last - first + 1 > MAX_PLAYLISTS:
            raise ExportError("Choose up to 20 playlists at a time.")
        for number in range(first, last + 1):
            if number not in selected:
                selected.append(number)
            if len(selected) > MAX_PLAYLISTS:
                raise ExportError("Choose up to 20 playlists at a time.")
    return [number - 1 for number in selected]


def normalize_track(row):
    song_id = row["id"]
    title, artist = readable_text(row["name"], 200), readable_text(row["singer"], 200)
    if not isinstance(song_id, int) or isinstance(song_id, bool) or not 0 < song_id <= MAX_ID or not title or not artist or artist.casefold() == "unknown artist":
        return None
    album = row["album"]
    album = "" if album is None or album == "" else readable_text(album, 200)
    if album is None:
        return None
    milliseconds = row["durationMs"]
    milliseconds = milliseconds if isinstance(milliseconds, (int, float)) and not isinstance(milliseconds, bool) and 0 < milliseconds <= 86400000 else None
    code = row["isrc"]
    code = code.upper() if isinstance(code, str) and re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", code, re.IGNORECASE) else None
    return {"id": "qq:" + str(song_id), "provider": "qq", "title": title, "artist": artist,
            "album": album, "durationMs": milliseconds, "isrc": code}


def export_selection(path, playlist_ids, expected_account=None):
    if not playlist_ids or len(playlist_ids) > MAX_PLAYLISTS or len(set(playlist_ids)) != len(playlist_ids):
        raise ExportError("Choose 1–20 different cached playlists to export.")
    if any(not isinstance(value, str) or not re.fullmatch(r"[1-9]\d{0,15}", value) for value in playlist_ids):
        raise ExportError("Choose playlists from the list shown by the helper.")
    database = connect_readonly(path)
    try:
        account = account_for(database)
        if expected_account is not None and hashlib.sha256(str(account).encode()).digest() != expected_account:
            raise ExportError("The QQ Music account changed after you chose a playlist. Run the helper again.")
        available = {item["id"]: item for item in playlist_rows(database, account)}
        if any(value not in available for value in playlist_ids):
            raise ExportError("A chosen playlist is no longer in this account's cache. Run the helper again.")
        columns = {row["name"] for row in database.execute("PRAGMA table_info(SONGS)")}
        duration_column = next((name for name in ("durationMs", "duration_ms") if name in columns), None)
        milliseconds = f's."{duration_column}"' if duration_column else "NULL"
        code = 's."isrc"' if "isrc" in columns else "NULL"
        membership_columns = {row["name"] for row in database.execute("PRAGMA table_info(NEWFOLDERSONGS)")}
        order = "fs.addtime DESC, fs.id, fs.type" if "addtime" in membership_columns else "fs.id, fs.type"
        playlists, total, omitted = [], 0, 0
        for playlist_id in playlist_ids:
            rows = database.execute(f"""
                SELECT s.id, s.name, s.singer, s.album, {milliseconds} AS durationMs, {code} AS isrc
                FROM NEWFOLDERSONGS fs JOIN SONGS s ON s.id = fs.id AND s.type = fs.type
                WHERE fs.seq = ? AND fs.opType = 0 ORDER BY {order} LIMIT ?
            """, (playlist_id, MAX_TRACKS + 1)).fetchall()
            if len(rows) > MAX_TRACKS:
                raise ExportError("A selected playlist has over 1,000 cached entries. Choose a smaller playlist; no songs were exported.")
            seen, tracks = set(), []
            for row in rows:
                track = normalize_track(row)
                if not track:
                    omitted += 1
                elif track["id"] not in seen:
                    seen.add(track["id"])
                    tracks.append(track)
            if not tracks:
                raise ExportError("A selected playlist has no readable cached song titles and artists. Open that playlist in QQ Music first.")
            total += len(tracks)
            if total > MAX_TRACKS:
                raise ExportError("Choose smaller playlists with up to 1,000 cached songs in total. No songs were exported.")
            playlists.append({"id": playlist_id, "name": available[playlist_id]["name"], "tracks": tracks})
        data = {"format": "jamama-qq-playlists", "version": 1, "playlists": playlists}
        encoded = (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        if len(encoded) > MAX_BYTES:
            raise ExportError("This selection is larger than 1 MB. Choose a smaller playlist; no songs were exported.")
        return data, omitted
    finally:
        database.close()


def write_export(data, directory):
    encoded = (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if len(encoded) > MAX_BYTES:
        raise ExportError("This selection is larger than 1 MB. Choose a smaller playlist.")
    directory = Path(directory).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    for number in range(1, 1001):
        filename = "Jamama QQ playlist" + ("" if number == 1 else f" {number}") + ".json"
        target = directory / filename
        try:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(encoded)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return target
    raise ExportError("There are too many existing exports in Downloads. Move an older Jamama QQ playlist file, then try again.")


def main(argv=None, input_fn=input, output_fn=print):
    parser = argparse.ArgumentParser(description="Export selected cached QQ Music Mac playlists as song metadata for Jamama.")
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE, help="QQ Music cache location (metadata only).")
    parser.add_argument("--output-directory", type=Path, default=Path.home() / "Downloads", help="Folder for the new JSON file.")
    args = parser.parse_args(argv)
    try:
        playlists, expected_account = read_playlists(args.database, with_account=True)
        if not playlists:
            raise ExportError("No cached playlists were found. Open a playlist in QQ Music first.")
        output_fn("\nJamama · QQ Music playlist exporter")
        output_fn("This reads song titles, artists and albums from QQ Music's local cache.")
        output_fn("It does not read passwords, cookies or audio. Nothing is uploaded.\n")
        for index, playlist in enumerate(playlists, 1):
            output_fn(f"{index}. {playlist['name']} · {playlist['trackCount']} cached songs")
        while True:
            choice = input_fn("\nChoose playlist numbers to export (e.g. 1 or 1,3). Enter q to cancel: ").strip()
            if choice.casefold() in ("q", "quit", "cancel"):
                output_fn("Cancelled. No file was created.")
                return 0
            try:
                selected = parse_selection(choice, len(playlists))
                break
            except ExportError as error:
                output_fn(str(error))
        data, omitted = export_selection(args.database, [playlists[index]["id"] for index in selected], expected_account)
        target = write_export(data, args.output_directory)
        count = sum(len(playlist["tracks"]) for playlist in data["playlists"])
        output_fn(f"\nSaved {len(data['playlists'])} playlist(s), {count} cached songs:")
        output_fn(str(target))
        if omitted:
            output_fn(f"{omitted} entries had unreadable or missing titles/artists and were omitted.")
        output_fn("The cache can be incomplete. Only the selected metadata is in this file.")
        output_fn("Return to Jamama's guessing game and choose this JSON file.")
        return 0
    except ExportError as error:
        output_fn(str(error))
        return 1
    except (sqlite3.Error, OSError, ValueError, TypeError):
        output_fn("QQ Music's cached playlists could not be read or the export could not be saved. Open QQ Music on this Mac and try again.")
        return 1
    except (EOFError, KeyboardInterrupt):
        output_fn("\nCancelled. No file was created.")
        return 0


if __name__ == "__main__":
    sys.exit(main())

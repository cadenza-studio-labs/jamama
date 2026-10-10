import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("qq_exporter", ROOT / "scripts/qq-playlist-export.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.database = self.directory / "fixture cache?name.sqlite"
        with closing(sqlite3.connect(self.database)) as database, database:
            database.executescript("""
                CREATE TABLE NEWFOLDERS(seq INTEGER PRIMARY KEY, uin INTEGER, folderName TEXT, K_USER_FOLDER_ORDER INTEGER);
                CREATE TABLE NEWFOLDERSONGS(seq INTEGER, id INTEGER, type INTEGER, addtime INTEGER, opType INTEGER);
                CREATE TABLE SONGS(id INTEGER, type INTEGER, name TEXT, singer TEXT, album TEXT, duration_ms INTEGER, isrc TEXT);
                CREATE TABLE ACCOUNT_LOGIN(password TEXT, cookie TEXT);
                INSERT INTO ACCOUNT_LOGIN VALUES('fixture-private-password', 'fixture-private-cookie');
                INSERT INTO NEWFOLDERS VALUES(7,42,'First fixture playlist',0),(8,42,'Second fixture playlist',1),(9,0,'System folder',2);
                INSERT INTO NEWFOLDERSONGS VALUES(7,111,13,20,0),(7,112,13,10,0),(7,113,13,30,1),(9,999,13,40,0),(8,114,13,20,0);
                INSERT INTO SONGS VALUES(111,13,'Fixture song one','Fixture artist','Fixture album',180000,'usaaa1234567'),
                  (111,0,'Wrong type','Wrong artist','Wrong album',200000,NULL),
                  (112,13,'Fixture song two','Fixture artist','Fixture album',NULL,NULL),
                  (113,13,'Deleted fixture','Artist','Album',180000,NULL),
                  (114,13,'Fixture song three','Second artist','Second album',190000,NULL),
                  (999,13,'System fixture','System artist','System album',180000,NULL);
            """)

    def modify(self, sql):
        with closing(sqlite3.connect(self.database)) as database, database:
            database.executescript(sql)

    def test_selected_metadata_only_preserves_database_and_unknown_fields(self):
        before = self.database.read_bytes()
        lists = exporter.read_playlists(self.database)
        self.assertEqual([playlist["id"] for playlist in lists], ["7", "8"])
        data, omitted = exporter.export_selection(self.database, ["7"])
        self.assertEqual(data["format"], "jamama-qq-playlists")
        self.assertEqual(data["version"], 1)
        self.assertEqual(len(data["playlists"]), 1)
        songs = data["playlists"][0]["tracks"]
        self.assertEqual([track["id"] for track in songs], ["qq:111", "qq:112"])
        self.assertEqual(songs[0]["durationMs"], 180000)
        self.assertEqual(songs[0]["isrc"], "USAAA1234567")
        self.assertIsNone(songs[1]["durationMs"])
        self.assertIsNone(songs[1]["isrc"])
        self.assertEqual(omitted, 0)
        text = json.dumps(data)
        for excluded in ["password", "cookie", "uin", "owner", "System fixture", "Wrong type", "Deleted fixture", "Fixture song three"]:
            self.assertNotIn(excluded, text)
        self.assertEqual(self.database.read_bytes(), before)

    def test_multiple_selection_deduplicates_membership_and_omits_bad_rows(self):
        self.modify("""
            INSERT INTO NEWFOLDERSONGS VALUES(7,111,13,0,0),(7,115,13,0,0),(7,116,13,0,0);
            INSERT INTO SONGS VALUES(115,13,'No artist',NULL,'Album',180000,NULL),
              (116,13,'Unsafe control' || char(27),'Artist','Album',180000,NULL);
        """)
        data, omitted = exporter.export_selection(self.database, ["8", "7"])
        self.assertEqual([playlist["id"] for playlist in data["playlists"]], ["8", "7"])
        self.assertEqual([len(playlist["tracks"]) for playlist in data["playlists"]], [1, 2])
        self.assertEqual(omitted, 2)

    def test_metadata_over_importer_limit_is_omitted_without_truncation(self):
        with closing(sqlite3.connect(self.database)) as database, database:
            database.execute("INSERT INTO SONGS VALUES(117,13,?,'Artist','Album',180000,NULL)", ("x" * 201,))
            database.execute("INSERT INTO SONGS VALUES(118,13,'Song',?,'Album',180000,NULL)", ("x" * 201,))
            database.execute("INSERT INTO SONGS VALUES(119,13,'Song','Artist',?,180000,NULL)", ("x" * 201,))
            database.executescript("INSERT INTO NEWFOLDERSONGS VALUES(7,117,13,0,0),(7,118,13,0,0),(7,119,13,0,0)")
        data, omitted = exporter.export_selection(self.database, ["7"])
        self.assertEqual(len(data["playlists"][0]["tracks"]), 2)
        self.assertEqual(omitted, 3)

    def test_selection_requires_list_numbers_and_blocks_injection(self):
        self.assertEqual(exporter.parse_selection("1, 3,2-3", 3), [0, 2, 1])
        for value in ["", "0", "4", "3-1", "1;SELECT", "1 OR 1=1", "1-1000000", "1," ]:
            with self.assertRaises(exporter.ExportError):
                exporter.parse_selection(value, 3)
        for ids in [[], ["7", "7"], ["9"], ["7 OR 1=1"]]:
            with self.assertRaises(exporter.ExportError):
                exporter.export_selection(self.database, ids)

    def test_accounts_are_never_guessed_and_changes_abort_export(self):
        _, signature = exporter.read_playlists(self.database, with_account=True)
        self.modify("UPDATE NEWFOLDERS SET uin=84 WHERE uin=42")
        with self.assertRaisesRegex(exporter.ExportError, "account changed"):
            exporter.export_selection(self.database, ["7"], signature)
        self.modify("INSERT INTO NEWFOLDERS VALUES(10,42,'Other account playlist',3)")
        with self.assertRaisesRegex(exporter.ExportError, "several accounts"):
            exporter.read_playlists(self.database)
        with self.assertRaisesRegex(exporter.ExportError, "several accounts"):
            exporter.export_selection(self.database, ["7"])

    def test_oversized_selection_never_silently_truncates(self):
        with closing(sqlite3.connect(self.database)) as database, database:
            for number in range(1000):
                database.execute("INSERT INTO SONGS VALUES(?,13,'Fixture track','Fixture artist','Album',180000,NULL)", (2000 + number,))
                database.execute("INSERT INTO NEWFOLDERSONGS VALUES(7,?,13,0,0)", (2000 + number,))
        with self.assertRaisesRegex(exporter.ExportError, "over 1,000"):
            exporter.export_selection(self.database, ["7"])

    def test_unknown_schema_and_missing_file_fail_without_creating_cache(self):
        missing = self.directory / "missing.sqlite"
        with self.assertRaises(sqlite3.Error):
            exporter.read_playlists(missing)
        self.assertFalse(missing.exists())
        self.modify("DROP TABLE SONGS")
        messages = []
        self.assertEqual(exporter.main(["--database", str(self.database)], output_fn=messages.append), 1)
        self.assertNotIn(str(self.database), "\n".join(messages))

    def test_older_cache_without_optional_duration_or_isrc_exports_null_values(self):
        self.modify("ALTER TABLE SONGS DROP COLUMN duration_ms; ALTER TABLE SONGS DROP COLUMN isrc;")
        data, _ = exporter.export_selection(self.database, ["7"])
        self.assertEqual(len(data["playlists"][0]["tracks"]), 2)
        self.assertTrue(all(track["durationMs"] is None and track["isrc"] is None for track in data["playlists"][0]["tracks"]))

    def test_exports_are_owner_only_and_existing_files_or_symlinks_survive(self):
        data, _ = exporter.export_selection(self.database, ["7"])
        output = self.directory / "Downloads"
        output.mkdir()
        unrelated = self.directory / "unrelated.json"
        unrelated.write_text("leave unchanged")
        (output / "Jamama QQ playlist.json").symlink_to(unrelated)
        first = exporter.write_export(data, output)
        second = exporter.write_export(data, output)
        self.assertEqual(first.name, "Jamama QQ playlist 2.json")
        self.assertEqual(second.name, "Jamama QQ playlist 3.json")
        self.assertEqual(unrelated.read_text(), "leave unchanged")
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o600)
        self.assertEqual(json.loads(first.read_text()), data)

    def test_cancelled_run_creates_no_export_and_cli_exports_only_selection(self):
        output = self.directory / "Downloads"
        messages = []
        args = ["--database", str(self.database), "--output-directory", str(output)]
        self.assertEqual(exporter.main(args, input_fn=lambda prompt: "q", output_fn=messages.append), 0)
        self.assertFalse(output.exists())
        self.assertEqual(exporter.main(args, input_fn=lambda prompt: "2", output_fn=messages.append), 0)
        exported = json.loads((output / "Jamama QQ playlist.json").read_text())
        self.assertEqual([playlist["id"] for playlist in exported["playlists"]], ["8"])
        self.assertEqual(len(exported["playlists"][0]["tracks"]), 1)


if __name__ == "__main__":
    unittest.main()

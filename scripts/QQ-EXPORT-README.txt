Jamama · QQ Music playlist exporter for Mac

1. Open the QQ Music Mac app and open the playlist you want to use.
2. Unzip this download. Keep all three files together.
3. Double-click “Export QQ Playlists.command”. A Terminal window opens.
4. Choose the playlist numbers shown, such as 1 or 1,3.
5. In Jamama's guessing game, choose the saved “Jamama QQ playlist.json”
   from Downloads.

The helper reads selected playlist metadata from QQ Music's cached SQLite
database. It exports song names, artists, albums, QQ song IDs and any
explicitly stored duration or recording ID. Missing information stays blank.
It never reads audio, cookies, passwords or authentication tokens.
It does not upload anything or change the QQ Music database or playlists.
The exported file remains on your Mac until you choose it in Jamama.

This is cached metadata, not QQ Music cloud login or a complete library sync.
Open a playlist in QQ Music first so its songs can be cached. Unavailable,
unloaded or unreadable entries may be missing. This helper refuses ambiguous
cached accounts rather than guessing which account you want. Each export is
limited to 20 selected playlists, 1,000 cached songs total and a 1 MB file.
It creates a new JSON file and never overwrites an existing export.

Python 3 is required. macOS may ask for developer tools if you only have the
system Python launcher. A Python 3 installation from python.org also works.
The .command launcher is readable source, not a signed/notarized Mac app.
If macOS blocks downloaded scripts, review both source files first; you can
run the Python file directly from Terminal instead of disabling Mac security.

Advanced use:
  python3 qq-playlist-export.py
  python3 qq-playlist-export.py --database /path/to/qqmusic.sqlite
  python3 qq-playlist-export.py --output-directory /path/to/a/folder

No existing cache, account information or personal song list is included
in this download. Jamama matches the selected song metadata against the
user's Apple Music catalog for quiz clues; an Apple Music subscription is needed.

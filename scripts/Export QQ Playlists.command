#!/bin/bash
set -u
helper_directory="$(cd -- "$(dirname -- "$0")" && pwd)"
helper_python=""
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [[ -x "$candidate" ]]; then
    helper_python="$candidate"
    break
  fi
done
if [[ -z "$helper_python" ]]; then
  echo "Python 3 is needed to read QQ Music's cached song lists."
  echo "Install Python 3 from https://www.python.org/downloads/macos/, then run this helper again."
else
  "$helper_python" -I "$helper_directory/qq-playlist-export.py"
fi
echo
read -r -p "Press Return to close this window. " ignored_reply

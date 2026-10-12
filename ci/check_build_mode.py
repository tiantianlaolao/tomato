"""Check the compiled mobile binary, not just workflow environment variables."""
import sys
from pathlib import Path
binary = Path(sys.argv[1]).read_bytes()
mode = sys.argv[2]
assert mode in ("public", "internal"), "Unknown build mode"
assert b"_mobile_marker_capyroom" in binary, "Mobile frontend missing"
public_guard = "不是内测包".encode("utf-8") in binary
assert public_guard == (mode == "public"), "Compiled internal flag differs from requested mode"
print(f"Compiled mobile build mode verified: {mode}")

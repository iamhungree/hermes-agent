"""OSV malware check for MCP extension packages.

Before launching an MCP server via npx/uvx, queries the OSV (Open Source
Vulnerabilities) API to check if the package has any known malware advisories
(MAL-* IDs).  Regular CVEs are ignored — only confirmed malware is blocked.

The API is free, public, and maintained by Google.  Typical latency is ~300ms.
Fail-open: network errors allow the package to proceed.

Inspired by Block/goose's extension malware check.
"""

import json
import logging
import os
import re
import urllib.request
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

_OSV_ENDPOINT = "https://api.osv.dev/v1/query"
_TIMEOUT = 10  # seconds


def check_package_for_malware(
    command: str, args: list
) -> Optional[str]:
    """Check if an MCP server package has known malware advisories.

    Inspects the *command* (e.g. ``npx``, ``uvx``) and *args* to infer the
    package name and ecosystem.  Queries the OSV API for MAL-* advisories.

    Returns:
        An error message string if malware is found, or None if clean/unknown.
        Returns None (allow) on network errors or unrecognized commands.
    """
    ecosystem = _infer_ecosystem(command)
    if not ecosystem:
        return None  # not npx/uvx — skip

    package, version = _parse_package_from_args(args, ecosystem)
    if not package:
        return None

    try:
        malware = _query_osv(package, ecosystem, version)
    except Exception as exc:
        # Fail-open: network errors, timeouts, parse failures → allow
        logger.debug("OSV check failed for %s/%s (allowing): %s", ecosystem, package, exc)
        return None

    if malware:
        ids = ", ".join(m["id"] for m in malware[:3])
        summaries = "; ".join(
            m.get("summary", m["id"])[:100] for m in malware[:3]
        )
        return (
            f"BLOCKED: Package '{package}' ({ecosystem}) has known malware "
            f"advisories: {ids}. Details: {summaries}"
        )
    return None


def _infer_ecosystem(command: str) -> Optional[str]:
    """Infer package ecosystem from the command name."""
    base = os.path.basename(command).lower()
    if base in {"npx", "npx.cmd"}:
        return "npm"
    if base in {"uvx", "uvx.cmd", "pipx"}:
        return "PyPI"
    return None


def _parse_package_from_args(
    args: list, ecosystem: str
) -> Tuple[Optional[str], Optional[str]]:
    """Extract package name and optional version from command args.

    Returns (package_name, version) or (None, None) if not parseable.
    """
    if not args:
        return None, None

    str_args = [a for a in args if isinstance(a, str)]

    # Honour npx's -p/--package flag: "npx -p @scope/pkg cmd" installs
    # @scope/pkg, not "cmd".  Without this, the command name is scanned
    # instead of the actual package, letting malicious packages slip through.
    package_token = None
    for i, arg in enumerate(str_args):
        if arg in ("-p", "--package") and i + 1 < len(str_args):
            package_token = str_args[i + 1]
            break

    # Fall back to the first non-flag positional argument
    if package_token is None:
        for arg in str_args:
            if not arg.startswith("-"):
                package_token = arg
                break

    if not package_token:
        return None, None

    if ecosystem == "npm":
        return _parse_npm_package(package_token)
    elif ecosystem == "PyPI":
        return _parse_pypi_package(package_token)
    return package_token, None


def _parse_npm_package(token: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse npm package: @scope/name@version or name@version."""
    if token.startswith("@"):
        # Scoped: @scope/name@version
        match = re.match(r"^(@[^/]+/[^@]+)(?:@(.+))?$", token)
        if match:
            version = match.group(2)
            # Dist-tags (latest, next, beta, canary, …) are not semver — OSV
            # returns zero advisories for them, silently bypassing the check.
            # Any version not starting with a digit is a dist-tag; normalise to
            # None so we query without a version constraint instead.
            if version and not re.match(r'^\d', version):
                version = None
            return match.group(1), version
        return token, None
    # Unscoped: name@version
    if "@" in token:
        parts = token.rsplit("@", 1)
        name = parts[0]
        version = parts[1] if re.match(r'^\d', parts[1]) else None
        return name, version
    return token, None


def _parse_pypi_package(token: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse PyPI package: name[extras][specifier] — only == captures a version."""
    # Match name + optional extras + optional version specifier.
    # Only == is captured as a version; other PEP 440 operators (>=, ~=, !=, ^=)
    # are consumed but not captured so we still extract the correct package name
    # instead of sending 'requests>=2.0' as a literal package name to OSV.
    match = re.match(r"^([a-zA-Z0-9._-]+)(?:\[[^\]]*\])?(?:==(.+)|[><=!~^].+)?$", token)
    if match:
        return match.group(1), match.group(2)
    return token, None


def _query_osv(
    package: str, ecosystem: str, version: Optional[str] = None
) -> list:
    """Query the OSV API for MAL-* advisories. Returns list of malware vulns."""
    payload = {"package": {"name": package, "ecosystem": ecosystem}}
    if version:
        payload["version"] = version

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _OSV_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "hermes-agent-osv-check/1.0",
        },
        method="POST",
    )

    _MAX_RESPONSE_BYTES = 1 * 1024 * 1024  # 1 MB cap
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        result = json.loads(resp.read(_MAX_RESPONSE_BYTES))

    vulns = result.get("vulns", [])
    # Only malware advisories — ignore regular CVEs
    return [v for v in vulns if v.get("id", "").startswith("MAL-")]

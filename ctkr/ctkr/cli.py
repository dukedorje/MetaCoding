"""ctkr command-line entry point.

Subcommands live in ``ctkr/commands/<name>.py``. Each module exposes:

    def register(subparsers) -> None:
        p = subparsers.add_parser("<name>", help="...")
        p.add_argument(...)
        p.set_defaults(func=run)

    def run(args) -> int:
        ...

``main`` discovers and registers every command module under
``ctkr.commands`` automatically — no central wiring needed.
"""

from __future__ import annotations

import argparse
import importlib
import pkgutil
import sys
from collections.abc import Sequence

from ctkr import __version__


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ctkr",
        description=(
            "MetaCoding structural analysis — graph mining, approximate mappings "
            "and evidence-linked enrichment (legacy ctkr command name)."
        ),
    )
    parser.add_argument("--version", action="version", version=f"ctkr {__version__}")
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")

    # Discover ctkr.commands.* submodules and let each register itself.
    try:
        commands_pkg = importlib.import_module("ctkr.commands")
    except ModuleNotFoundError:
        return parser

    for mod_info in pkgutil.iter_modules(commands_pkg.__path__):
        mod = importlib.import_module(f"ctkr.commands.{mod_info.name}")
        register = getattr(mod, "register", None)
        if register is None:
            continue
        register(subparsers)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 0
    return int(func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())

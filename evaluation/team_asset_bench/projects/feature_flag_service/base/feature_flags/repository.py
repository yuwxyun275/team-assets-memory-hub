from typing import Iterable, List, Optional

from .models import FeatureFlag


class FlagRepository:
    """SQLite-shaped repository kept in memory so the benchmark is dependency-free."""

    def __init__(self, flags: Iterable[FeatureFlag]) -> None:
        self.flags: List[FeatureFlag] = list(flags)
        self.read_calls = 0

    def get_published(self, tenant_id: str, key: str) -> Optional[FeatureFlag]:
        self.read_calls += 1
        return next(
            (
                flag
                for flag in self.flags
                if flag.tenant_id == tenant_id and flag.key == key and flag.status == "published"
            ),
            None,
        )

    def get_any_by_key(self, key: str) -> Optional[FeatureFlag]:
        """Dangerous legacy lookup retained to make cross-tenant regressions testable."""
        self.read_calls += 1
        return next((flag for flag in self.flags if flag.key == key), None)

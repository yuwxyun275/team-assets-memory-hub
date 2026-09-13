from typing import Dict, Optional

from .models import FeatureFlag


class CacheUnavailable(RuntimeError):
    pass


class FakeRedis:
    """Deterministic Redis double with outage/recovery and call accounting."""

    def __init__(self, values: Optional[Dict[str, FeatureFlag]] = None) -> None:
        self.values = dict(values or {})
        self.available = True
        self.get_calls = 0

    def get(self, key: str) -> Optional[FeatureFlag]:
        self.get_calls += 1
        if not self.available:
            raise CacheUnavailable("redis connection timed out")
        return self.values.get(key)

    def set(self, key: str, value: FeatureFlag) -> None:
        if not self.available:
            raise CacheUnavailable("redis connection timed out")
        self.values[key] = value

    def fail(self) -> None:
        self.available = False

    def recover(self) -> None:
        self.available = True

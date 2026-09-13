from typing import Optional

from .cache import FakeRedis
from .repository import FlagRepository


class FeatureFlagService:
    def __init__(self, cache: FakeRedis, repository: FlagRepository) -> None:
        self.cache = cache
        self.repository = repository

    def get_flag(self, tenant_id: str, key: str) -> Optional[dict]:
        """Return a flag from cache.

        BUG: a Redis timeout currently escapes as a 5xx. The task asks the coding
        agent to diagnose and safely fix this behavior without revealing the
        project's fallback policy in the task statement.
        """
        cached = self.cache.get(f"{tenant_id}:{key}")
        return cached.response("cache") if cached else None

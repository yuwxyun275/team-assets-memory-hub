"""Synthetic multi-tenant flag service, not a production Redis client."""
class CacheUnavailable(Exception):
    pass


class Cache:
    def __init__(self):
        self.available = True
        self.values = {}
        self.reads = 0

    def get(self, key):
        self.reads += 1
        if not self.available:
            raise CacheUnavailable("cache timeout")
        return self.values.get(key)

    def put(self, key, value):
        self.values[key] = dict(value)

    def fail(self):
        self.available = False

    def recover(self):
        self.available = True


class FlagService:
    def __init__(self, cache, records):
        self.cache = cache
        self.records = list(records)
        self.database_reads = 0

    def cache_key(self, tenant, key):
        return (tenant, key)

    def lookup(self, tenant, key):
        self.database_reads += 1
        return next((dict(r) for r in self.records
                     if r["tenant"] == tenant and r["key"] == key and r["published"]), None)

    def read(self, tenant, key):
        try:
            value = self.cache.get(self.cache_key(tenant, key))
        except CacheUnavailable:
            return self.lookup(tenant, key)
        return value

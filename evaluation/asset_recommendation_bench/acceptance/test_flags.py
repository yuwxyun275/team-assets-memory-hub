import unittest
from service import Cache, CacheUnavailable, FlagService


def build():
    cache = Cache()
    records = [{"tenant": "a", "key": "f", "published": True, "enabled": True},
               {"tenant": "b", "key": "f", "published": True, "enabled": False},
               {"tenant": "a", "key": "draft", "published": False, "enabled": True}]
    return cache, FlagService(cache, records)


class Acceptance(unittest.TestCase):
    def test_failure_and_recovery(self):
        cache, svc = build()
        cache.fail()
        self.assertEqual(svc.read("a", "f")["tenant"], "a")
        self.assertEqual(cache.reads, 1)
        self.assertEqual(svc.database_reads, 1)
        cache.recover()
        cache.put(("a", "f"), {"enabled": False})
        self.assertEqual(svc.read("a", "f"), {"enabled": False})
        self.assertEqual(svc.database_reads, 1)

    def test_missing_and_draft_on_failure(self):
        cache, svc = build()
        cache.fail()
        self.assertIsNone(svc.read("unknown", "f"))
        self.assertIsNone(svc.read("a", "draft"))

    def test_normal_miss_never_reads_database(self):
        cache, svc = build()
        self.assertIsNone(svc.read("a", "f"))
        self.assertEqual(svc.database_reads, 0)
        cache.put(("a", "f"), {"enabled": True})
        self.assertEqual(svc.read("a", "f"), {"enabled": True})
        self.assertEqual(svc.database_reads, 0)

    def test_tenant_publication_boundary(self):
        cache, svc = build()
        cache.fail()
        self.assertEqual(svc.read("b", "f")["tenant"], "b")
        self.assertIsNone(svc.read("c", "f"))
        self.assertIsNone(svc.read("a", "draft"))

    def test_non_cache_error_not_swallowed(self):
        cache, svc = build()
        def broken(_):
            raise TypeError("programming defect")
        cache.get = broken
        with self.assertRaises(TypeError):
            svc.read("a", "f")


if __name__ == "__main__":
    unittest.main()

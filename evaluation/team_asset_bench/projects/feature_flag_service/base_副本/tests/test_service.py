from feature_flags import FeatureFlag, FeatureFlagService, FakeRedis, FlagRepository


def build_service():
    flag = FeatureFlag("tenant-a", "checkout-v2", True)
    cache = FakeRedis({"tenant-a:checkout-v2": flag})
    repository = FlagRepository([flag])
    return FeatureFlagService(cache, repository), cache, repository


def test_cache_hit_returns_tenant_flag():
    service, _, _ = build_service()
    assert service.get_flag("tenant-a", "checkout-v2") == {
        "tenant_id": "tenant-a",
        "key": "checkout-v2",
        "enabled": True,
        "source": "cache",
    }


def test_cache_miss_returns_none():
    service, _, _ = build_service()
    assert service.get_flag("tenant-a", "missing") is None


def test_normal_path_does_not_read_database():
    service, _, repository = build_service()
    service.get_flag("tenant-a", "checkout-v2")
    assert repository.read_calls == 0

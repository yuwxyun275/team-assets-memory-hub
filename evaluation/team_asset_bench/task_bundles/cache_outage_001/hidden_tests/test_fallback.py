from feature_flags import FeatureFlag, FeatureFlagService, FakeRedis, FlagRepository


def build_outage_service():
    flags = [
        FeatureFlag("tenant-b", "checkout-v2", False, "published"),
        FeatureFlag("tenant-a", "checkout-v2", True, "published"),
        FeatureFlag("tenant-a", "draft-only", True, "draft"),
        FeatureFlag("tenant-b", "draft-only", False, "published"),
    ]
    cache = FakeRedis({"tenant-a:checkout-v2": flags[1]})
    repository = FlagRepository(flags)
    return FeatureFlagService(cache, repository), cache, repository


def test_outage_falls_back_to_published_flag_for_same_tenant():
    service, cache, _ = build_outage_service()
    cache.fail()
    assert service.get_flag("tenant-a", "checkout-v2") == {
        "tenant_id": "tenant-a",
        "key": "checkout-v2",
        "enabled": True,
        "source": "database",
    }


def test_outage_never_leaks_another_tenant():
    service, cache, _ = build_outage_service()
    cache.fail()
    assert service.get_flag("tenant-c", "checkout-v2") is None


def test_outage_never_exposes_draft_flag():
    service, cache, _ = build_outage_service()
    cache.fail()
    assert service.get_flag("tenant-a", "draft-only") is None


def test_outage_does_not_retry_redis():
    service, cache, _ = build_outage_service()
    cache.fail()
    service.get_flag("tenant-a", "checkout-v2")
    assert cache.get_calls == 1


def test_recovery_uses_cache_without_database_fallback():
    service, cache, repository = build_outage_service()
    cache.fail()
    service.get_flag("tenant-a", "checkout-v2")
    reads_after_outage = repository.read_calls
    cache.recover()
    response = service.get_flag("tenant-a", "checkout-v2")
    assert response["source"] == "cache"
    assert repository.read_calls == reads_after_outage


def test_missing_flag_during_outage_returns_none():
    service, cache, _ = build_outage_service()
    cache.fail()
    assert service.get_flag("tenant-a", "not-exist") is None

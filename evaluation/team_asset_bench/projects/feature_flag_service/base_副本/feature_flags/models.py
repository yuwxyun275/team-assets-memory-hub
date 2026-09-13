from dataclasses import dataclass


@dataclass(frozen=True)
class FeatureFlag:
    tenant_id: str
    key: str
    enabled: bool
    status: str = "published"

    def response(self, source: str) -> dict:
        return {
            "tenant_id": self.tenant_id,
            "key": self.key,
            "enabled": self.enabled,
            "source": source,
        }

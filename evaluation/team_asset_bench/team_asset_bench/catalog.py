from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .models import Asset, Task
from .orchestrator import stable_content_hash


class SourceValidationError(ValueError):
    pass


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def build_catalog(root: Path, manifest_path: Path) -> Tuple[List[Asset], Dict[str, object]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assets: List[Asset] = []
    audit: List[Dict[str, object]] = []
    seen = set()
    root_resolved = root.resolve()
    for raw in manifest.get("assets", []):
        asset_id = raw.get("asset_id")
        if not asset_id or asset_id in seen:
            raise SourceValidationError(f"missing or duplicate asset_id: {asset_id!r}")
        seen.add(asset_id)
        source_ref = str(raw.get("source_ref", ""))
        source_path = (root / source_ref).resolve()
        if root_resolved not in source_path.parents:
            raise SourceValidationError(f"source path escapes benchmark root: {source_ref}")
        if not source_path.is_file():
            raise SourceValidationError(f"source does not exist: {source_ref}")
        source_text = source_path.read_text(encoding="utf-8")
        missing = [anchor for anchor in raw.get("evidence_anchors", []) if anchor not in source_text]
        if missing:
            raise SourceValidationError(f"{asset_id} has ungrounded anchors: {missing}")
        value = dict(raw)
        value.pop("evidence_anchors", None)
        value["content_hash"] = stable_content_hash(source_text)
        asset = Asset.from_dict(value)
        assets.append(asset)
        audit.append(
            {
                "asset_id": asset.asset_id,
                "source_ref": source_ref,
                "content_hash": asset.content_hash,
                "anchors_verified": True,
                "candidate_status": asset.evidence_state.value,
            }
        )
    return assets, {"schema_version": "team-asset-ingestion-audit/v1", "assets": audit}


def load_assets(root: Optional[Path] = None) -> List[Asset]:
    benchmark_root = root or project_root()
    generated = benchmark_root / "generated" / "catalog.json"
    if generated.exists():
        data = json.loads(generated.read_text(encoding="utf-8"))
        return [Asset.from_dict(item) for item in data["assets"]]
    assets, _ = build_catalog(benchmark_root, benchmark_root / "raw" / "source_manifest.json")
    return assets


def write_catalog(root: Optional[Path] = None) -> Tuple[Path, Path]:
    benchmark_root = root or project_root()
    assets, audit = build_catalog(benchmark_root, benchmark_root / "raw" / "source_manifest.json")
    generated = benchmark_root / "generated"
    generated.mkdir(parents=True, exist_ok=True)
    catalog_path = generated / "catalog.json"
    audit_path = generated / "ingestion-audit.json"
    catalog_path.write_text(
        json.dumps(
            {"schema_version": "team-asset-catalog/v1", "assets": [asset.to_dict() for asset in assets]},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return catalog_path, audit_path


def load_task(root: Optional[Path] = None) -> Task:
    benchmark_root = root or project_root()
    value = json.loads(
        (benchmark_root / "task_bundles" / "cache_outage_001" / "task.json").read_text(encoding="utf-8")
    )
    return Task.from_dict(value)

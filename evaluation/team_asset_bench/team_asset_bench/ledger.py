from __future__ import annotations

import json
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from .models import AssetEvent, AssetState


_ORDER = {
    AssetState.RECALLED: 0,
    AssetState.SELECTED: 1,
    AssetState.INJECTED: 2,
    AssetState.USED: 3,
    AssetState.VALIDATED: 4,
    AssetState.CONTRIBUTED: 5,
    AssetState.CORRECTED: 6,
}


class InvalidAssetTransition(ValueError):
    pass


class EvidenceLedger:
    """Append-only event ledger with fail-closed lifecycle transitions."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path
        self._events: List[AssetEvent] = []
        self._lock = threading.Lock()
        if path and path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    self._events.append(AssetEvent.from_dict(json.loads(line)))

    def append(
        self,
        *,
        trace_id: str,
        task_id: str,
        asset_id: str,
        state: AssetState,
        actor_type: str,
        actor_id: str,
        target: Optional[str] = None,
        decision: Optional[str] = None,
        evidence_ref: Optional[str] = None,
        detail: Optional[Dict[str, object]] = None,
    ) -> AssetEvent:
        with self._lock:
            previous = self.latest_state(trace_id, task_id, asset_id)
            self._validate_transition(previous, state, target, decision, evidence_ref)
            event = AssetEvent(
                event_id=f"evt-{uuid.uuid4().hex[:16]}",
                trace_id=trace_id,
                task_id=task_id,
                asset_id=asset_id,
                state=state,
                actor_type=actor_type,
                actor_id=actor_id,
                timestamp=datetime.now(timezone.utc).isoformat(),
                target=target,
                decision=decision,
                evidence_ref=evidence_ref,
                detail=dict(detail or {}),
            )
            self._events.append(event)
            if self.path:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(event.to_dict(), ensure_ascii=False, sort_keys=True) + "\n")
            return event

    def latest_state(self, trace_id: str, task_id: str, asset_id: str) -> Optional[AssetState]:
        for event in reversed(self._events):
            if event.trace_id == trace_id and event.task_id == task_id and event.asset_id == asset_id:
                return event.state
        return None

    def events(
        self,
        *,
        trace_id: Optional[str] = None,
        task_id: Optional[str] = None,
        asset_id: Optional[str] = None,
    ) -> List[AssetEvent]:
        return [
            event
            for event in self._events
            if (trace_id is None or event.trace_id == trace_id)
            and (task_id is None or event.task_id == task_id)
            and (asset_id is None or event.asset_id == asset_id)
        ]

    def grouped_states(self, trace_id: str, task_id: str) -> Dict[str, List[str]]:
        grouped: Dict[str, List[str]] = defaultdict(list)
        for event in self.events(trace_id=trace_id, task_id=task_id):
            grouped[event.asset_id].append(event.state.value)
        return dict(grouped)

    def replace_events(self, events: Iterable[AssetEvent]) -> None:
        """Test helper; never used by the runtime append path."""
        with self._lock:
            self._events = list(events)

    @staticmethod
    def _validate_transition(
        previous: Optional[AssetState],
        state: AssetState,
        target: Optional[str],
        decision: Optional[str],
        evidence_ref: Optional[str],
    ) -> None:
        if previous is None and state not in (AssetState.RECALLED, AssetState.CORRECTED):
            raise InvalidAssetTransition(f"first state must be recalled/corrected, got {state.value}")
        if previous is not None:
            if state == previous:
                return
            if state is AssetState.CORRECTED:
                return
            if _ORDER[state] != _ORDER[previous] + 1:
                raise InvalidAssetTransition(f"cannot transition {previous.value} -> {state.value}")
        if state is AssetState.USED and (not target or not decision):
            raise InvalidAssetTransition("used requires a concrete target and decision")
        if state in (AssetState.VALIDATED, AssetState.CONTRIBUTED) and not evidence_ref:
            raise InvalidAssetTransition(f"{state.value} requires independent evidence_ref")


def event_key(event: AssetEvent) -> Tuple[str, str, str]:
    return event.trace_id, event.task_id, event.asset_id

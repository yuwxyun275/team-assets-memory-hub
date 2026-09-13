import io
import json
from unittest.mock import patch
from urllib.error import HTTPError

import pytest
from team_asset_bench.server import HubAuthority


def test_write_denial_is_not_silently_reported_as_success():
    authority = HubAuthority('http://core', 'default', 'user', 'test-key')
    with patch('team_asset_bench.server.urlopen', side_effect=HTTPError('http://core', 403, 'denied', {}, None)):
        with pytest.raises(RuntimeError, match='hub_write_failed:task/update'):
            authority._post('task/update', {'task_id': 'task'})
        assert authority._post('task/get', {'task_id': 'task'}) is None


def test_application_error_and_missing_task_block_publication():
    authority = HubAuthority('http://core', 'default', 'user', 'test-key')
    with patch('team_asset_bench.server.urlopen', return_value=io.BytesIO(json.dumps({'code':403,'message':'private error'}).encode())):
        with pytest.raises(RuntimeError, match='hub_write_failed:asset/create'):
            authority._post('asset/create', {})
    with patch.object(authority, '_post', return_value=None):
        with pytest.raises(RuntimeError, match='hub_receipt_task_unavailable'):
            authority.update_task_receipt('task', {})

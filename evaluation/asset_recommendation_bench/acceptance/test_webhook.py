import hashlib
import hmac
import unittest
from unittest.mock import patch
import service
from service import verify, Inbox, next_delay, delivery_complete


class Acceptance(unittest.TestCase):
    def test_signature_exact_bytes(self):
        raw = b'{"x": 1}'
        sig = hmac.new(b"test-only-key", raw, hashlib.sha256).hexdigest()
        self.assertTrue(verify(b"test-only-key", raw, sig))
        self.assertFalse(verify(b"test-only-key", b'{"x":1}', sig))
        self.assertFalse(verify(b"wrong-key", raw, sig))
        self.assertFalse(verify(b"test-only-key", raw, sig[:-1] + ("0" if sig[-1] != "0" else "1")))
        self.assertFalse(verify(b"test-only-key", raw, None))

    def test_dedup_tenant_and_event(self):
        inbox = Inbox()
        self.assertTrue(inbox.accept("a", "e1", {}))
        self.assertFalse(inbox.accept("a", "e1", {}))
        self.assertTrue(inbox.accept("b", "e1", {}))
        self.assertTrue(inbox.accept("a", "e2", {}))
        self.assertEqual(inbox.count(), 3)

    def test_compare_digest_is_used(self):
        raw = b"demo"
        signature = hmac.new(b"test-only-key", raw, hashlib.sha256).hexdigest()
        original = hmac.compare_digest
        with patch.object(service.hmac, "compare_digest", wraps=original) as comparison:
            self.assertTrue(verify(b"test-only-key", raw, signature))
            comparison.assert_called_once_with(signature, signature)

    def test_retry_window(self):
        for status in [429, 500, 503, 599]:
            self.assertEqual([next_delay(i, status) for i in range(5)], [1, 2, 4, None, None])
        for status in [200, 302, 400, 401, 404, 600]:
            self.assertIsNone(next_delay(0, status))
        with self.assertRaises(ValueError):
            next_delay(-1, 500)

    def test_completion_range(self):
        for status in [200, 204, 299]:
            self.assertTrue(delivery_complete(status))
        for status in [199, 300, 429, 500]:
            self.assertFalse(delivery_complete(status))


if __name__ == "__main__":
    unittest.main()

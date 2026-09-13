"""Synthetic Webhook primitives; no outbound network or real credentials."""
import hashlib
import hmac


def sign(secret, raw_body):
    return hmac.new(secret, raw_body, hashlib.sha256).hexdigest()


def verify(secret, raw_body, signature):
    if not isinstance(signature, str):
        return False
    expected = sign(secret, raw_body)
    return hmac.compare_digest(expected, signature)


def event_key(tenant, event_id):
    return (tenant, event_id)


class Inbox:
    def __init__(self):
        self.seen = set()
        self.handled = []

    def accept(self, tenant, event_id, payload):
        key = event_key(tenant, event_id)
        if key in self.seen:
            return False
        self.seen.add(key)
        self.handled.append((tenant, event_id, payload))
        return True

    def count(self):
        return len(self.handled)


def retryable(status):
    return status == 429 or 500 <= status <= 599


def next_delay(attempt, status):
    if type(attempt) is not int or attempt < 0:
        raise ValueError("zero-based nonnegative attempt required")
    if not retryable(status) or attempt >= 3:
        return None
    return min(2 ** attempt, 4)


def delivery_complete(status):
    return 200 <= status <= 299

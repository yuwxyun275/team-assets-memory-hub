'''Synthetic currency rules for evaluation, not accounting/legal advice.'''
from decimal import Decimal, ROUND_HALF_UP


def amount(value):
    result = Decimal(str(value))
    if not result.is_finite() or result < 0:
        raise ValueError('finite nonnegative amount required')
    return result


def round_money(value):
    return value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def line_total(price, quantity):
    if type(quantity) is not int or quantity <= 0:
        raise ValueError('positive integer quantity required')
    return round_money(amount(price) * quantity)


def same_currency(lines, currency):
    return all(line['currency'] == currency for line in lines)


def subtotal(lines, currency):
    if not same_currency(lines, currency):
        raise ValueError('mixed currencies')
    return sum(
        (line_total(line['price'], line['quantity']) for line in lines),
        Decimal('0.00'),
    )


def total(lines, currency, credit='0'):
    base = subtotal(lines, currency)
    requested = round_money(amount(credit))
    return max(base - requested, Decimal('0.00'))


def format_total(value, currency):
    return {'currency': currency, 'total': format(round_money(value), '.2f')}


def invoice(lines, currency, credit='0'):
    return format_total(total(lines, currency, credit), currency)

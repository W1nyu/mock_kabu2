import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('notify', Path(__file__).with_name('storage-notify.py'))
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class NotifyTest(unittest.TestCase):
    def test_normal_state_is_quiet(self):
        self.assertFalse(notify.decision({}, {}, 1790098116)[0])

    def test_first_alert(self):
        self.assertTrue(notify.decision({'critical': ['disk-critical']}, {}, 1790098116)[0])

    def test_errors_consume_monthly_cap(self):
        prior = dict(month='2026-09', attempts=100)
        self.assertFalse(notify.decision({'critical': ['disk-critical']}, prior, 1790098116, True)[0])

    def test_hourly_limit_even_for_test_and_changed_alert(self):
        prior = dict(attempt_at=1790098100)
        self.assertFalse(notify.decision({'critical': ['disk-critical']}, prior, 1790098116, True)[0])

    def test_recovery_notification(self):
        self.assertTrue(notify.decision({}, {'active': True}, 1790098116)[0])

    def test_identical_alert_waits_six_hours(self):
        status = {'critical': ['disk-critical']}
        _, fp, _, _ = notify.decision(status, {}, 1790098116)
        prior = dict(fingerprint=fp, sent_at=1790094000, active=True)
        self.assertFalse(notify.decision(status, prior, 1790098116)[0])


if __name__ == '__main__':
    unittest.main()

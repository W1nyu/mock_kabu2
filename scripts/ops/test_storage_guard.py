import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('storage-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTest(unittest.TestCase):
    def healthy(self, **kw):
        return dict(disk_percent=32, free_bytes=31*guard.GIB, inode_percent=2, **kw)

    def test_healthy(self):
        self.assertEqual(guard.assess(self.healthy()), ([], []))

    def test_disk_free_reserve(self):
        m = self.healthy()
        m['free_bytes'] = 6*guard.GIB
        self.assertIn('disk-critical', guard.assess(m)[1])

    def test_transient_archive_failure_does_not_stop_bots(self):
        self.assertFalse(guard.assess(self.healthy(wal_pending=1, wal_oldest_seconds=60))[1])
        self.assertIn('wal-archive-stalled', guard.assess(self.healthy(wal_pending=1, wal_oldest_seconds=900))[1])

    def test_old_failure_counter_is_not_current_failure(self):
        self.assertEqual(guard.assess(self.healthy(archive_failed_count=22, wal_pending=0)), ([], []))

    def test_stale_backup(self):
        self.assertFalse(guard.assess(self.healthy(backup_age_seconds=8*3600))[1])
        self.assertTrue(guard.assess(self.healthy(backup_age_seconds=12*3600))[1])

    def test_forecast_ignores_short_samples_and_reclaimed_space(self):
        current = dict(time=2000, used_bytes=200, free_bytes=800)
        self.assertIsNone(guard.forecast([dict(time=1960, used_bytes=100)], current))
        self.assertIsNone(guard.forecast([dict(time=0, used_bytes=300)], current))
        self.assertAlmostEqual(guard.forecast([dict(time=0, used_bytes=100)], current), 800/0.05/3600)


if __name__ == '__main__':
    unittest.main()

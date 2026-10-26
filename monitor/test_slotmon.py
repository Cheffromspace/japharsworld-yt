"""Outage, replacement, swap and flash-fail paths against a fake YouTube.  py -m unittest test_slotmon  (from monitor/)"""
import json, os, tempfile, time, unittest
from unittest import mock

from slotmon import config, core, db, publish
from slotmon.youtube import parse_date_text

SLOTS = [
    {"key": "radio", "url": "https://www.youtube.com/watch?v=OLDOLDOLD01", "playlist": "PLradio", "title": "Sleep radio", "channel": "Lofi", "category": "music", "hidden": False},
    {"key": "cam", "url": "https://www.youtube.com/watch?v=CAMCAMCAM01", "title": "Cam", "channel": "Cams", "category": "cities", "hidden": False},
    {"key": "noise", "url": "https://www.youtube.com/watch?v=NOISENOISE1", "title": "Noise", "channel": "DJ", "category": "sounds", "hidden": False},
    {"key": "spare", "url": "https://www.youtube.com/watch?v=SPARESPARE1", "title": "Spare", "channel": "X", "category": "music", "hidden": True},
]
OVERRIDES = {"notice": "", "slots": {"noise": {"kind": "video"}, "cam": {"title": "Tokyo cam"}}}
H = 3600


def st(vid, status, title="sleep lofi radio 24/7", channel="Lofi", cid="UClofi", started=None):
    return {"source": "fake", "video_id": vid, "status": status, "title": title, "channel": channel, "channel_id": cid,
            "started_at": started if started is not None else time.time() - 400 * H, "started_precision": "exact", "viewers": 10}


class FakeApi:
    can_read = True
    can_write = True

    def __init__(self, con):
        self.con, self.calls, self.playlists = con, [], {"PLradio": [("i1", "OLDOLDOLD01")]}
        self.world = {}

    def videos(self, ids):
        return {v: self.world.get(v, st(v, "live")) for v in ids}

    def used_today(self):
        return 0

    def quota_day(self):
        return "d"

    def playlist_items(self, pl, essential=False):
        self.calls.append(("list", pl))
        return list(self.playlists[pl])

    def insert_first(self, pl, vid):
        self.calls.append(("insert", pl, vid))
        self.playlists[pl].insert(0, ("n" + vid, vid))

    def delete_item(self, item):
        self.calls.append(("delete", item))
        for pl in self.playlists.values():
            pl[:] = [i for i in pl if i[0] != item]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.con = db.connect(os.path.join(self.tmp, "t.db"))
        self.api = FakeApi(self.con)
        self.alerts, self.mentions = [], []

        def send(con, title, body="", level="info", **k):
            self.alerts.append((level, title))
            if k.get("mention"):
                self.mentions.append(title)
        self.p = [mock.patch("slotmon.discord.send", send),
                  mock.patch.object(core, "Api", lambda con: self.api),
                  mock.patch.object(core, "channel_live_ids", lambda cid: self.live_ids.get(cid, [])),
                  mock.patch.object(core.time, "sleep", lambda s: None)]
        for p in self.p:
            p.start()
        self.live_ids = {}
        core.sync_slots(self.con, SLOTS, OVERRIDES)

    def tearDown(self):
        for p in self.p:
            p.stop()
        self.con.close()

    def check(self):
        core.check_pass(self.con, self.api, OVERRIDES)

    def slot(self, key):
        return self.con.execute("SELECT * FROM slots WHERE key=?", (key,)).fetchone()

    def jobs(self):
        return self.con.execute("SELECT * FROM jobs WHERE done IS NULL").fetchall()

    def result(self, job, height=1080, verdict="pass", fps=0, live="is_live"):
        r = {"id": job["id"], "video_id": job["video_id"], "runner": "pc", "ts": time.time(), "live_status": live, "height": height, "format_id": "96"}
        if verdict:
            r["flash"] = {"verdict": verdict, "max_fps": fps, "regions": [fps] * 5, "frames": 450, "mean_luminance": 0.05}
        core.submit_results(self.con, self.api, [r], OVERRIDES)


class Tests(Base):
    def test_only_a_mass_outage_pings_the_owner(self):
        # Owner, 2026-10-26: one outage or flash fail stays unmentioned; MASS_DOWN shown slots out at once pings.
        with mock.patch.object(config, "MASS_DOWN", 2):
            self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "ended")
            self.check()
            core.outage_watch(self.con, OVERRIDES)
            self.assertTrue(self.slot("cam")["auto_hidden"])
            self.assertEqual(self.mentions, [], "one slot down: no ping")
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='flash fail' WHERE key='radio'")
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='down' WHERE key='spare'")  # baked hidden: not counted
            core.outage_watch(self.con, OVERRIDES)
            self.assertEqual(self.mentions, ["2 channels down or hidden at once"])
            db.set_meta(self.con, "alert:mass-down", time.time())  # as discord.send records it
            self.con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key='radio'")
            core.outage_watch(self.con, OVERRIDES)
            self.assertEqual(self.alerts[-1], ("good", "Channels back"))
            self.assertEqual(len(self.mentions), 1, "the all-clear does not ping")

    def test_mention_payload_pings_that_user_only(self):
        from slotmon import discord
        sent = []
        real_send = self.p[0].temp_original  # Base mocks discord.send; this is the real one
        with mock.patch.object(config, "DISCORD_WEBHOOK", "https://hook"), mock.patch.object(config, "DISCORD_MENTION", "<@123456789012>"), \
                mock.patch.object(discord, "http", lambda url, data=None, **k: sent.append(json.loads(data))):
            real_send(self.con, "FLASH FAIL: x @everyone", "b", "urgent")
            real_send(self.con, "8 channels down or hidden at once", "b", "urgent", mention=True)
        self.assertNotIn("content", sent[0], "an urgent alert alone pings nobody")
        self.assertEqual(sent[0]["allowed_mentions"], {"parse": []})
        self.assertEqual(sent[1]["content"], "<@123456789012>")
        self.assertEqual(sent[1]["allowed_mentions"], {"parse": [], "users": ["123456789012"]})
        with mock.patch.object(config, "DISCORD_MENTION", "123456789012"):
            self.assertEqual(discord.mention_id(), "123456789012")
        with mock.patch.object(config, "DISCORD_MENTION", "@here"):
            self.assertIsNone(discord.mention_id())
    def test_api_warnings_get_an_all_clear_once_the_api_answers(self):
        core.statuses(self.con, self.api, ["CAMCAMCAM01"])
        self.assertEqual(self.alerts, [])  # nothing was wrong: no all-clear
        db.set_meta(self.con, "alert:api-error", time.time())  # as discord.send records a sent warning
        core.statuses(self.con, self.api, ["CAMCAMCAM01"])
        core.statuses(self.con, self.api, ["CAMCAMCAM01"])
        self.assertEqual(self.alerts, [("good", "YouTube API works again: status checks use it again")])
        self.assertFalse(db.get_meta(self.con, "alert:api-error", 0))

    def test_all_up_queues_new_flash_checks_but_not_for_videos(self):
        self.api.world["NOISENOISE1"] = st("NOISENOISE1", "video")
        self.check()
        self.assertEqual(sorted(j["video_id"] for j in self.jobs()), ["CAMCAMCAM01", "OLDOLDOLD01", "SPARESPARE1"])
        self.assertFalse(self.slot("noise")["auto_hidden"])

    def test_restart_is_swapped_in_after_flash_pass(self):
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        self.check()  # first pass also learns the channel id
        s = self.slot("radio")
        self.assertTrue(s["auto_hidden"])
        cand = [j for j in self.jobs() if j["reason"] == "candidate"]
        self.assertEqual([j["video_id"] for j in cand], ["NEWNEWNEW01"])  # restart: allowed although only 10 minutes old
        self.assertEqual(json.loads(publish.dumps(publish.status_doc(SLOTS, core.slot_rows(self.con), OVERRIDES)))["slots"]["radio"], {"hidden": True})
        self.result(cand[0])
        s = self.slot("radio")
        self.assertEqual(s["current_video"], "NEWNEWNEW01")
        self.assertFalse(s["auto_hidden"])
        self.assertEqual(self.api.playlists["PLradio"], [("nNEWNEWNEW01", "NEWNEWNEW01")])
        self.assertIn(("insert", "PLradio", "NEWNEWNEW01"), self.api.calls)
        self.assertTrue(any(t.startswith("Replaced") for _, t in self.alerts))

    def test_new_unrelated_stream_is_too_new(self):
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["OTHEROTHER1"] = st("OTHEROTHER1", "live", title="24/7 piano for studying", started=time.time() - 5 * H)
        self.live_ids["UClofi"] = ["OTHEROTHER1"]
        self.check()
        self.assertFalse([j for j in self.jobs() if j["reason"] == "candidate"])
        self.assertTrue(any(t.startswith("No replacement") for _, t in self.alerts))

    def test_asmr_candidate_rejected(self):
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["ASMRASMRAS1"] = st("ASMRASMRAS1", "live", title="sleep lofi radio 24/7 ASMR")
        self.live_ids["UClofi"] = ["ASMRASMRAS1"]
        self.check()
        self.assertEqual(db.stream(self.con, "ASMRASMRAS1")["rejected"], "banned word in title/channel")

    def test_candidate_fails_flash_or_resolution(self):
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7")
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        self.check()
        cand = [j for j in self.jobs() if j["reason"] == "candidate"][0]
        self.result(cand, height=480)
        self.assertEqual(self.slot("radio")["current_video"], "OLDOLDOLD01")
        self.assertTrue(self.slot("radio")["auto_hidden"])
        self.assertEqual(db.stream(self.con, "NEWNEWNEW01")["rejected"], "480p")
        self.assertNotIn(("insert", "PLradio", "NEWNEWNEW01"), self.api.calls)

    def test_flash_fail_on_playing_stream_hides_and_empties_playlist(self):
        self.check()
        job = [j for j in self.jobs() if j["video_id"] == "OLDOLDOLD01"][0]
        self.result(job, verdict="fail", fps=9)
        s = self.slot("radio")
        self.assertTrue(s["auto_hidden"])
        self.assertEqual(s["auto_reason"], "flash fail")
        self.assertEqual(self.api.playlists["PLradio"], [])
        self.assertEqual(self.alerts[-1][0], "urgent")
        self.assertTrue(db.get_meta(self.con, "publish_now"))
        self.check()  # stays hidden even though the stream is live
        self.assertTrue(self.slot("radio")["auto_hidden"])

    def test_flash_fail_on_baked_link_slot_warns_it_is_still_baked(self):
        self.check()
        job = [j for j in self.jobs() if j["video_id"] == "CAMCAMCAM01"][0]
        self.result(job, verdict="fail", fps=5)
        self.assertTrue(self.slot("cam")["auto_hidden"])

    def test_one_miss_on_error_is_ignored_two_unknowns_hide(self):
        self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "error")
        self.check()
        self.assertFalse(self.slot("cam")["auto_hidden"])
        self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "upcoming")
        self.check()
        self.assertFalse(self.slot("cam")["auto_hidden"])
        self.check()
        self.assertTrue(self.slot("cam")["auto_hidden"])
        self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "live")
        self.check()
        self.assertFalse(self.slot("cam")["auto_hidden"])

    def test_no_playlist_slot_cannot_swap(self):
        self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "ended", cid="UCcam", title="Tokyo live camera 24/7")
        self.api.world["CAM2CAM2CA1"] = st("CAM2CAM2CA1", "live", cid="UCcam", title="Tokyo live camera 24/7")
        self.live_ids["UCcam"] = ["CAM2CAM2CA1"]
        self.check()
        self.result([j for j in self.jobs() if j["reason"] == "candidate"][0])
        self.assertEqual(self.slot("cam")["current_video"], "CAMCAMCAM01")
        self.assertTrue(any("no playlist" in t for _, t in self.alerts))

    def test_status_doc_overrides_and_spare(self):
        doc = publish.status_doc(SLOTS, core.slot_rows(self.con), {"notice": "hi", "slots": {"spare": {"hidden": False, "category": "space"}, "cam": {"title": "Tokyo cam", "category": "bogus"}}})
        self.assertEqual(doc, {"notice": "hi", "slots": {"spare": {"hidden": False, "category": "space"}, "cam": {"title": "Tokyo cam"}}})

    def test_sheet_size_matches_baker(self):
        self.assertEqual(publish.sheet_size(67), (2048, 1024))
        self.assertEqual(publish.sheet_size(95), (2048, 2048))

    def test_bot_wall_page_is_an_error_not_an_outage(self):
        from slotmon.youtube import parse_watch
        wall = 'var ytInitialPlayerResponse = {"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in to confirm you\\u2019re not a bot"}};</script>'
        self.assertEqual(parse_watch(wall)["status"], "error")
        gone = 'var ytInitialPlayerResponse = {"playabilityStatus": {"status": "ERROR", "reason": "Video unavailable"}};</script>'
        self.assertEqual(parse_watch(gone)["status"], "unavailable")

    def test_date_text(self):
        self.assertAlmostEqual(parse_date_text("Started streaming 5 hours ago", 100000), 100000 - 5 * H)
        self.assertIsNotNone(parse_date_text("Started streaming on Oct 1, 2026"))

    def test_daily_queues_and_follows_manual_playlist_edit(self):
        config.DAILY_HOUR_UTC = 0
        self.check()
        self.con.execute("UPDATE jobs SET done=1")
        self.api.playlists["PLradio"] = [("x", "MANUALMANU1")]
        core.maybe_daily(self.con, self.api, OVERRIDES)
        self.assertEqual(self.slot("radio")["current_video"], "MANUALMANU1")
        self.assertTrue(any(j["reason"] == "daily" for j in self.jobs()))
        self.assertTrue(any(t == "Daily summary" for _, t in self.alerts))

    def test_unreported_claim_is_handed_out_again_after_an_hour(self):
        self.check()
        n = len(self.jobs())
        self.assertEqual(len(core.claim_jobs(self.con, "optiplex", 12)), n)
        self.assertEqual(core.claim_jobs(self.con, "optiplex", 12), [])  # still claimed
        self.con.execute("UPDATE jobs SET claimed=?", (time.time() - core.CLAIM_SECONDS - 60,))
        self.assertEqual(len(core.claim_jobs(self.con, "optiplex", 12)), n)


class WorkerTests(unittest.TestCase):
    def run_worker(self, verdicts):
        from slotmon import worker
        jobs = [{"id": i, "video_id": "V%d" % i, "slot_key": "s%d" % i, "reason": "daily", "flash": True} for i in range(len(verdicts))]
        sent = []

        def remote(args, stdin=None):
            if args.startswith("claim"):
                return json.dumps(jobs)
            sent.append([r["id"] for r in json.loads(stdin)])
            return "took %d results" % len(sent[-1])

        run = lambda j, runner: {"id": j["id"], "video_id": j["video_id"], "flash": {"verdict": verdicts[j["id"]], "max_fps": 0}}
        with mock.patch.object(worker, "remote", remote), mock.patch.object(worker.probe, "run_job", run), mock.patch.object(worker, "log", lambda m: None):
            self.assertEqual(worker.main(), 0)
        return sent

    def test_flash_fail_is_sent_at_once_and_the_rest_still_run(self):
        self.assertEqual(self.run_worker(["pass", "fail", "pass", "pass"]), [[0, 1], [2, 3]])

    def test_fail_last_is_one_submit(self):
        self.assertEqual(self.run_worker(["pass", "fail"]), [[0, 1]])


if __name__ == "__main__":
    unittest.main()

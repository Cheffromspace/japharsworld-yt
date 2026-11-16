"""Outage, replacement, swap and flash-fail paths against a fake YouTube.  py -m unittest test_slotmon  (from monitor/)"""
import json, os, tempfile, time, unicodedata, unittest
from unittest import mock

from slotmon import config, core, db, discord, publish
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
        self.alerts, self.mentions, self.notes, self.bodies = [], [], [], []

        def send(con, title, body="", level="info", **k):
            self.alerts.append((level, title))
            self.bodies.append(body)
            if k.get("mention"):
                self.mentions.append(title)
        self.p = [mock.patch("slotmon.discord.send", send),
                  mock.patch("slotmon.discord.note", lambda con, title, body="", level="info": self.notes.append((level, title))),
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
    def test_a_mass_outage_alerts_once_without_a_ping(self):
        # Owner, 2026-10-26: one outage or flash fail is the monitor's own; MASS_DOWN shown slots out at once alert,
        # with no mention (#246).
        with mock.patch.object(config, "MASS_DOWN", 2):
            self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "ended")
            self.check()
            core.outage_watch(self.con, OVERRIDES)
            self.assertTrue(self.slot("cam")["auto_hidden"])
            self.assertEqual(self.mentions, [], "one slot down: no ping")
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='flash fail' WHERE key='radio'")
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='down' WHERE key='spare'")  # baked hidden: not counted
            core.outage_watch(self.con, OVERRIDES)
            self.assertEqual(self.alerts[-1], ("urgent", "2 channels down or hidden at once"))
            self.assertEqual(self.mentions, [], "no ping (#246)")
            n = len(self.alerts)
            self.con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key='radio'")
            core.outage_watch(self.con, OVERRIDES)
            self.assertEqual(len(self.alerts), n, "no all-clear (owner, 2026-10-29: the warning and the daily summary only)")

    def test_a_mass_outage_warns_at_most_once_in_24_hours(self):
        # Owner, 2026-10-29: the real dedupe, not the mock: a second outage within 24 h sends nothing, one after it does.
        sent = []
        with mock.patch.object(config, "MASS_DOWN", 2), mock.patch.object(discord, "send", self.p[0].temp_original), \
                mock.patch.object(config, "DISCORD_WEBHOOK", "https://example/hook"), \
                mock.patch.object(discord, "http", lambda url, data=None, **k: sent.append(json.loads(data)["embeds"][0]["title"])):
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='down' WHERE key IN ('radio','cam')")
            core.outage_watch(self.con, OVERRIDES)
            core.outage_watch(self.con, OVERRIDES)
            self.con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL")
            core.outage_watch(self.con, OVERRIDES)
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='down' WHERE key IN ('radio','cam')")
            core.outage_watch(self.con, OVERRIDES)
            self.assertEqual(sent, ["2 channels down or hidden at once"], "once, and not again after a recovery the same day")
            db.set_meta(self.con, "alert:mass-down", time.time() - 25 * H)
            core.outage_watch(self.con, OVERRIDES)
            self.assertEqual(len(sent), 2, "again after 24 h")

    def test_replacements_send_no_message_and_go_in_the_daily_summary(self):
        # Owner, 2026-10-29: no Discord message per channel event; the daily summary has the count, the channels and
        # the failures.
        bodies = []
        self.p[0].stop()
        self.p[0] = mock.patch("slotmon.discord.send", lambda con, title, body="", level="info", **k: (self.alerts.append((level, title)), bodies.append(body)))
        self.p[0].start()
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        self.api.world["CAMCAMCAM01"] = st("CAMCAMCAM01", "ended", cid="UCcam", title="Tokyo live camera 24/7")
        self.api.world["CAM2CAM2CA1"] = st("CAM2CAM2CA1", "live", cid="UCcam", title="Tokyo live camera 24/7")
        self.live_ids["UCcam"] = ["CAM2CAM2CA1"]
        self.check()
        for j in [j for j in self.jobs() if j["reason"] == "candidate"]:
            self.result(j)
        self.assertEqual(self.slot("radio")["current_video"], "NEWNEWNEW01")
        self.assertEqual(self.alerts, [], "down, candidate, replaced and a failed swap: no Discord message")
        titles = [t for _, t in self.notes]
        for want in ("Stream down", "Replacement found", "Replaced", "Replacement ready but slot has no playlist"):
            self.assertTrue(any(t.startswith(want) for t in titles), want)
        config.DAILY_HOUR_UTC = 0
        self.con.execute("UPDATE jobs SET done=1")
        core.maybe_daily(self.con, self.api, OVERRIDES)
        self.assertEqual([t for _, t in self.alerts], ["Daily summary"])
        lines = bodies[-1].split("\n")
        self.assertIn("Replacements (24 h): 1: Sleep radio", lines)
        self.assertIn("Replacement failures: Cam (no slot playlist (the world bakes the old link))", lines)

    def test_flash_worker_refusals_are_counted_by_class_only(self):
        # Owner, 2026-10-26: the same classes as src/refusal.js; the monitor keeps an event per refusal, class only.
        from slotmon import probe
        self.assertEqual(probe.refusal_class("ERROR: [youtube] x: Sign in to confirm you're not a bot"), "bot")
        self.assertEqual(probe.refusal_class("HTTP Error 429: Too Many Requests"), "rate")
        self.assertEqual(probe.refusal_class("Server returned 403 Forbidden (access denied)"), "forbidden")
        self.assertEqual(probe.refusal_class("something else"), "other")
        with mock.patch.object(probe, "extract", side_effect=RuntimeError("ERROR: Sign in to confirm you're not a bot")):
            r = probe.run_job({"id": 1, "video_id": "CAMCAMCAM01"}, "optiplex")
        self.assertEqual((r["error"][:5], r["refusal"]), ("ERROR", "bot"))
        # ffmpeg's stream fetch refused: too few frames, classified from its stderr.
        with mock.patch.object(probe.subprocess, "run", lambda cmd, **k: mock.Mock(stdout=b"", stderr=b"Server returned 403 Forbidden")), \
                mock.patch.object(probe, "ffmpeg_path", lambda: "ffmpeg"):
            self.assertEqual(probe.flash_check("https://x"), {"frames": 0, "verdict": "too-few-frames", "refusal": "forbidden"})
        self.check()
        job = self.jobs()[0]
        core.submit_results(self.con, self.api, [{"id": job["id"], "video_id": job["video_id"], "runner": "optiplex", "ts": time.time(),
                                                   "error": "ERROR: Sign in to confirm", "refusal": "bot"}], OVERRIDES)
        core.submit_results(self.con, self.api, [{"id": job["id"], "video_id": job["video_id"], "runner": "pc", "ts": time.time(),
                                                   "error": "HTTP Error 429"}], OVERRIDES)  # an older worker: classified here
        core.submit_results(self.con, self.api, [{"id": job["id"], "video_id": job["video_id"], "runner": "pc", "ts": time.time(),
                                                   "error": "timeout"}], OVERRIDES)  # our own timeout is not a refusal
        rows = self.con.execute("SELECT detail FROM events WHERE kind='yt_refusal' ORDER BY id").fetchall()
        self.assertEqual([r["detail"] for r in rows], ["bot", "rate"])

    def test_flash_sample_length_is_a_setting_with_room_to_finish(self):
        # Owner, 2026-10-26: 60 s by default (15 before); ffmpeg gets the sample plus 120 s.
        from slotmon import probe
        seen = []
        with mock.patch.object(probe.subprocess, "run", lambda cmd, **k: seen.append((cmd, k["timeout"])) or mock.Mock(stdout=b"", stderr=b"")), \
                mock.patch.object(probe, "ffmpeg_path", lambda: "ffmpeg"):
            probe.frames("https://x")
            with mock.patch.object(config, "FLASH_SECONDS", 120):
                probe.frames("https://x")
        self.assertEqual(config.FLASH_SECONDS, 60)
        self.assertEqual([(c[c.index("-t") + 1], t) for c, t in seen], [("60", 180), ("120", 240)])

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

    def test_critical_alerts_go_to_the_critical_webhook_when_set(self):
        from slotmon import discord
        urls = []
        real_send = self.p[0].temp_original
        with mock.patch.object(config, "DISCORD_WEBHOOK", "https://usual"),                 mock.patch.object(discord, "http", lambda url, data=None, **k: urls.append(url)):
            real_send(self.con, "8 channels down or hidden at once", "b", "urgent", mention=True)
            with mock.patch.object(config, "DISCORD_CRITICAL_WEBHOOK", "https://critical"):
                real_send(self.con, "8 channels down or hidden at once", "b", "urgent", mention=True)
                real_send(self.con, "Stream down: x", "b", "urgent")
                real_send(self.con, "Channels back", "b", "good", critical=True)
        self.assertEqual(urls, ["https://usual", "https://critical", "https://usual", "https://critical"])

    def test_mass_outage_stays_on_the_usual_channel_unmentioned(self):
        import inspect
        src = inspect.getsource(core.outage_watch)
        self.assertNotIn("mention=True", src)
        self.assertNotIn("critical=True", src)
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
        self.assertTrue(any(t.startswith("Replaced") for _, t in self.notes))

    def test_new_unrelated_stream_is_too_new(self):
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["OTHEROTHER1"] = st("OTHEROTHER1", "live", title="24/7 piano for studying", started=time.time() - 5 * H)
        self.live_ids["UClofi"] = ["OTHEROTHER1"]
        self.check()
        self.assertFalse([j for j in self.jobs() if j["reason"] == "candidate"])
        self.assertTrue(any(t.startswith("No replacement") for _, t in self.notes))

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
        self.assertTrue(any("no playlist" in t for _, t in self.notes))

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

    def test_retired_slot_is_hidden_and_out_of_every_check(self):
        # Owner, 2026-10-29: long-down channels are retired in overrides.json (hidden + unmanaged), not removed.
        config.DAILY_HOUR_UTC = 0
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.check()
        self.assertEqual(self.slot("radio")["auto_reason"], "down")
        ov = {"notice": "", "slots": dict(OVERRIDES["slots"], radio={"hidden": True, "kind": "unmanaged", "retired": "2026-10-29: down"})}
        core.sync_slots(self.con, SLOTS, ov)
        radio_checks = lambda: self.con.execute("SELECT COUNT(*) FROM checks WHERE slot_key='radio'").fetchone()[0]
        n = radio_checks()
        self.api.calls.clear()
        core.check_pass(self.con, self.api, ov)
        core.maybe_daily(self.con, self.api, ov)
        self.assertEqual(radio_checks(), n)
        self.assertGreater(self.con.execute("SELECT COUNT(*) FROM checks WHERE slot_key='cam'").fetchone()[0], 1)
        self.assertNotIn(("list", "PLradio"), self.api.calls)
        core.outage_watch(self.con, ov)
        self.assertFalse(any("at once" in t for _, t in self.alerts))
        self.assertEqual(publish.status_doc(SLOTS, core.slot_rows(self.con), ov)["slots"]["radio"], {"hidden": True})

    def test_shown_spare_is_checked_counted_and_published(self):
        # Owner, 2026-10-29: the spare lofi-study shown through overrides.json, monitored like any shown live slot.
        config.DAILY_HOUR_UTC = 0
        ov = {"notice": "", "slots": dict(OVERRIDES["slots"], spare={"hidden": False})}
        core.sync_slots(self.con, SLOTS, ov)
        self.assertEqual(self.slot("spare")["baked_hidden"], 0)  # the exporter's eiok_slot_spare reads this
        self.assertTrue(core.is_shown(self.slot("spare"), ov))
        self.assertEqual(publish.status_doc(SLOTS, core.slot_rows(self.con), ov)["slots"]["spare"], {"hidden": False})
        self.api.world["SPARESPARE1"] = st("SPARESPARE1", "ended")
        core.check_pass(self.con, self.api, ov)
        self.assertEqual(self.slot("spare")["auto_reason"], "down")
        self.assertEqual(publish.status_doc(SLOTS, core.slot_rows(self.con), ov)["slots"].get("spare"), None)  # hidden again, as baked
        self.con.execute("UPDATE jobs SET done=1")
        core.maybe_daily(self.con, self.api, ov)
        self.assertIn("of 4** shown slots", next(b for b in self.bodies if "shown slots up" in b))
        core.sync_slots(self.con, SLOTS, OVERRIDES)
        self.assertEqual(self.slot("spare")["baked_hidden"], 1)

    def test_unreported_claim_is_handed_out_again_after_an_hour(self):
        self.check()
        n = len(self.jobs())
        self.assertEqual(len(core.claim_jobs(self.con, "optiplex", 12)), n)
        self.assertEqual(core.claim_jobs(self.con, "optiplex", 12), [])  # still claimed
        self.con.execute("UPDATE jobs SET claimed=?", (time.time() - core.CLAIM_SECONDS - 60,))
        self.assertEqual(len(core.claim_jobs(self.con, "optiplex", 12)), n)


# A slot whose title follows its stream (Everything-is-OK#793, owner 2026-11-15: "Can we change it to follow the stream
# title?"). The stream title the monitor journal showed for borneo-jungle-night at 2026-11-15 17:00:17Z:
CAMPFIRE = "\U0001F534 Lonely Lakeside Campfire · LIVE 24/7 · Boundary Waters Fire Crackling for Sleep \U0001F525"
FOLLOW = {"notice": "", "slots": {"noise": {"kind": "video"}, "cam": {"title": "Tokyo cam"},
                                  "radio": {"title": "Radio fallback", "title_from": "stream"}}}


class FlashHoldTests(Base):
    """#776 (2026-11-16): a flash-fail hide holds until a person clears it, whatever happens to the stream."""

    def fail_radio(self):
        """radio's stream fails its first check: hidden, playlist emptied (the existing flash-fail path)."""
        self.check()
        self.result([j for j in self.jobs() if j["video_id"] == "OLDOLDOLD01"][0], verdict="fail", fps=8)
        self.assertEqual(self.slot("radio")["auto_reason"], "flash fail")
        self.assertEqual(self.api.playlists["PLradio"], [])

    def published(self, ov=OVERRIDES):
        with mock.patch.object(config, "DATA_DIR", self.tmp), mock.patch.object(config, "PUBLISH", False), \
                mock.patch.object(publish, "build_sheet", lambda slots, cur: (b"", [])):
            core.publish_pass(self.con, SLOTS, ov)
        with open(os.path.join(self.tmp, "out", config.STATUS_FILE), encoding="utf-8") as f:
            return json.load(f)["slots"]

    def test_the_hold_outlives_the_stream_and_no_restart_is_looked_for(self):
        # retroworld-ps1, 2026-11-07 to 11-15: the stream that failed ends, the channel starts a same-title stream.
        self.fail_radio()
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        looked = []
        with mock.patch.object(core, "channel_live_ids", lambda cid: looked.append(cid) or self.live_ids.get(cid, [])):
            self.check()
            self.check()
        s = self.slot("radio")
        self.assertTrue(s["auto_hidden"])
        self.assertEqual(s["auto_reason"], "flash fail")  # was 'down' (core.py handle_down, before #776)
        self.assertTrue(s["down_since"])
        self.assertEqual(looked, [])  # no replacement search
        self.assertFalse([j for j in self.jobs() if j["reason"] == "candidate"])
        self.assertEqual(self.api.playlists["PLradio"], [])  # nothing for a PC with a stale list to play
        self.assertTrue(any("until a person clears it" in t or "Stream down" in t for _, t in self.notes))
        # The copy of the world's list says shown (hidden false); the status file must say hidden, explicitly.
        self.assertFalse(SLOTS[0]["hidden"])
        self.assertEqual(self.published()["radio"], {"hidden": True})
        # A stream back up does not bring it back either.
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "live")
        self.check()
        self.assertEqual(self.slot("radio")["auto_reason"], "flash fail")
        self.assertFalse(any(t.startswith("Back up") for _, t in self.notes))

    def test_a_candidate_that_passes_never_swaps_a_held_slot(self):
        # The stream ends and a candidate is queued; then a flash fail on the old stream arrives (a job claimed earlier);
        # then the candidate passes. The swap used to clear the hide (core.py swap, before #776).
        self.check()
        old_job = [j for j in self.jobs() if j["video_id"] == "OLDOLDOLD01"][0]
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        self.check()
        cand = [j for j in self.jobs() if j["reason"] == "candidate"]
        self.assertEqual([j["video_id"] for j in cand], ["NEWNEWNEW01"])
        self.result(old_job, verdict="fail", fps=8)
        self.result(cand[0])
        s = self.slot("radio")
        self.assertEqual(s["current_video"], "OLDOLDOLD01")
        self.assertTrue(s["auto_hidden"])
        self.assertEqual(s["auto_reason"], "flash fail")
        self.assertNotIn(("insert", "PLradio", "NEWNEWNEW01"), self.api.calls)
        self.assertEqual(self.api.playlists["PLradio"], [])
        # The fresh-pass swap (a candidate that passed within 24 h) is refused the same way.
        self.assertFalse(core.swap(self.con, self.api, s, "NEWNEWNEW01", True))
        self.assertEqual(self.slot("radio")["auto_reason"], "flash fail")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE slot_key='radio' AND kind='swap_held'").fetchone()[0], 1)

    def test_a_hold_set_while_the_playlist_is_written_keeps_the_slot_hidden_and_empties_the_playlist(self):
        # A worker's submit runs beside the pass: a flash fail can land between the swap's check and its write.
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.check()
        row = self.slot("radio")
        db.upsert_stream(self.con, "NEWNEWNEW01", flash_verdict="pass", flash_max=0, flash_at=time.time(), height=1080)
        insert = self.api.insert_first

        def insert_then_fail(pl, vid):
            insert(pl, vid)
            self.con.execute("UPDATE slots SET auto_hidden=1, auto_reason='flash fail' WHERE key='radio'")
        self.api.insert_first = insert_then_fail
        self.assertFalse(core.swap(self.con, self.api, row, "NEWNEWNEW01", True))
        s = self.slot("radio")
        self.assertEqual((s["current_video"], s["auto_hidden"], s["auto_reason"]), ("OLDOLDOLD01", 1, "flash fail"))
        self.assertEqual(self.api.playlists["PLradio"], [])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE slot_key='radio' AND kind='replaced'").fetchone()[0], 0)

    def test_a_hold_another_path_wrote_over_is_put_back_from_the_event_log(self):
        # retroworld-ps1 on production at 2026-11-16 04:59Z (read-only read): a flash_fail event of 11-07 and no clear,
        # but its row not hidden (auto_hidden 0, auto_reason NULL) and playing a stream that passed once.
        self.fail_radio()
        db.upsert_stream(self.con, "NEWNEWNEW01", flash_verdict="pass", flash_max=2, flash_at=time.time(), height=1080)
        self.con.execute("UPDATE slots SET current_video='NEWNEWNEW01', down_since=NULL, auto_hidden=0, auto_reason=NULL WHERE key='radio'")
        self.con.commit()
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live")
        # A restart of the monitor reads the same database.
        self.con.close()
        self.con = db.connect(os.path.join(self.tmp, "t.db"))
        self.check()
        s = self.slot("radio")
        self.assertTrue(s["auto_hidden"])
        self.assertEqual(s["auto_reason"], "flash fail")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE slot_key='radio' AND kind='flash_hold'").fetchone()[0], 1)
        self.assertTrue(any(t.startswith("Flash-fail hide put back") for _, t in self.notes))
        self.check()  # once: nothing to put back the second time
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE slot_key='radio' AND kind='flash_hold'").fetchone()[0], 1)
        # A publish alone puts it back too (slotmon publish, or a submit's publish, between passes).
        self.con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key='radio'")
        self.assertEqual(self.published()["radio"], {"hidden": True})
        # Retired as well (gta-vice-city): still held, out of the checks.
        ov = {"notice": "", "slots": dict(OVERRIDES["slots"], radio={"hidden": True, "kind": "unmanaged", "retired": "2026-11-15: flash fail"})}
        core.sync_slots(self.con, SLOTS, ov)
        self.con.execute("UPDATE slots SET auto_hidden=0, auto_reason=NULL WHERE key='radio'")
        core.check_pass(self.con, self.api, ov)
        self.assertEqual(self.slot("radio")["auto_reason"], "flash fail")
        self.assertEqual(self.published(ov)["radio"], {"hidden": True})
        # ... and without its override: the hold alone keeps it hidden.
        core.sync_slots(self.con, SLOTS, OVERRIDES)
        self.assertEqual(self.published()["radio"], {"hidden": True})

    def test_a_held_slot_on_another_stream_keeps_its_daily_sample_and_skips_the_playlist_follow(self):
        config.DAILY_HOUR_UTC = 0
        self.fail_radio()
        db.upsert_stream(self.con, "NEWNEWNEW01", flash_verdict="pass", flash_max=2, flash_at=time.time() - 30 * H, height=1080)
        self.con.execute("UPDATE slots SET current_video='NEWNEWNEW01' WHERE key='radio'")
        self.con.execute("UPDATE jobs SET done=1")
        self.api.playlists["PLradio"] = [("x", "MANUALMANU1")]  # a hand edit while held
        core.maybe_daily(self.con, self.api, OVERRIDES)
        daily = [j["video_id"] for j in self.jobs() if j["reason"] == "daily"]
        self.assertIn("NEWNEWNEW01", daily)  # sampled though hidden (before #776 a hidden slot got no daily sample)
        self.assertEqual(self.slot("radio")["current_video"], "NEWNEWNEW01")  # the hand edit is not followed while held
        # A daily sample that passes leaves the hold as it is; the stream that failed is never sampled again.
        self.result([j for j in self.jobs() if j["video_id"] == "NEWNEWNEW01"][0], fps=1)
        self.assertEqual(self.slot("radio")["auto_reason"], "flash fail")
        self.con.execute("UPDATE slots SET current_video='OLDOLDOLD01' WHERE key='radio'")
        self.con.execute("UPDATE jobs SET done=1")
        db.set_meta(self.con, "last_daily", "")
        core.maybe_daily(self.con, self.api, OVERRIDES)
        self.assertNotIn("OLDOLDOLD01", [j["video_id"] for j in self.jobs() if j["reason"] == "daily"])

    def test_clear_flash_on_the_stream_that_failed_waits_for_a_checked_replacement(self):
        self.fail_radio()
        self.assertIn("no flash-fail hold", core.clear_flash(self.con, "cam"))
        self.assertIn("no slot", core.clear_flash(self.con, "nope"))
        line = core.clear_flash(self.con, "radio")
        self.assertIn("stays hidden as down", line)
        s = self.slot("radio")
        self.assertEqual((s["auto_hidden"], s["auto_reason"]), (1, "down"))
        self.assertTrue(db.get_meta(self.con, "publish_now"))
        # The stream that failed is still live: it does not bring the slot back, and a replacement is looked for.
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["OLDOLDOLD01", "NEWNEWNEW01"]
        self.check()
        s = self.slot("radio")
        self.assertEqual((s["auto_hidden"], s["auto_reason"]), (1, "down"))
        self.assertFalse(any(t.startswith("Back up") for _, t in self.notes))
        cand = [j for j in self.jobs() if j["reason"] == "candidate"]
        self.assertEqual([j["video_id"] for j in cand], ["NEWNEWNEW01"])  # never the stream that failed
        self.result(cand[0])
        s = self.slot("radio")
        self.assertEqual((s["current_video"], s["auto_hidden"]), ("NEWNEWNEW01", 0))
        self.check()  # the event log has the clear: not held again
        self.assertEqual(self.slot("radio")["auto_hidden"], 0)
        self.assertNotIn("radio", self.published())
        # A new flash fail after the clear holds it again.
        self.con.execute("UPDATE jobs SET done=1")
        core.queue_job(self.con, "NEWNEWNEW01", "radio", "manual")
        self.result([j for j in self.jobs() if j["video_id"] == "NEWNEWNEW01"][0], verdict="fail", fps=6)
        self.con.execute("UPDATE slots SET auto_reason='down' WHERE key='radio'")
        self.check()
        self.assertEqual(self.slot("radio")["auto_reason"], "flash fail")

    def test_clear_flash_on_a_stream_that_passed_shows_the_slot(self):
        self.fail_radio()
        db.upsert_stream(self.con, "NEWNEWNEW01", flash_verdict="pass", flash_max=2, flash_at=time.time(), height=1080)
        self.con.execute("UPDATE slots SET current_video='NEWNEWNEW01' WHERE key='radio'")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live")
        line = core.clear_flash(self.con, "radio")
        self.assertIn("is shown from this publish", line)
        self.assertEqual(self.slot("radio")["auto_hidden"], 0)
        self.check()
        self.assertEqual(self.slot("radio")["auto_hidden"], 0)
        self.assertNotIn("radio", self.published())
        # With an owner's hide (retroworld-ps1's override) it stays hidden by that.
        self.assertEqual(self.published({"notice": "", "slots": {"radio": {"hidden": True}}})["radio"], {"hidden": True})

    def test_a_candidate_queued_before_a_retirement_does_not_swap(self):
        # Verifier Low 1 on f187ac2 (2026-11-15): react swapped a down slot's candidate without looking at its kind.
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        self.check()
        cand = [j for j in self.jobs() if j["reason"] == "candidate"][0]
        ov = {"notice": "", "slots": dict(OVERRIDES["slots"], radio={"hidden": True, "kind": "unmanaged", "retired": "2026-11-16: test"})}
        core.sync_slots(self.con, SLOTS, ov)
        self.result(cand)
        self.assertEqual(self.slot("radio")["current_video"], "OLDOLDOLD01")
        self.assertNotIn(("insert", "PLradio", "NEWNEWNEW01"), self.api.calls)


class FollowTitleTests(Base):
    def doc(self, overrides=FOLLOW):
        return json.loads(publish.dumps(core.published_doc(self.con, SLOTS, overrides)))

    def checked(self, vid, title, overrides=FOLLOW):
        self.api.world[vid] = st(vid, "live", title=title)
        core.check_pass(self.con, self.api, overrides)

    def test_clean_title_of_the_campfire_stream(self):
        self.assertEqual(publish.clean_title(CAMPFIRE), "Lonely Lakeside Campfire · Boundary Waters Fire Crackling for Sleep")

    def test_clean_title_of_only_markers_and_emoji_is_empty(self):
        for t in ("\U0001F534 LIVE 24/7 \U0001F525", "Live Now: 24 / 7 | \U0001F319✨", "\U0001F525 · live · \U0001F525", "", None, "   "):
            self.assertEqual(publish.clean_title(t), "", t)

    def test_clean_title_leaves_a_plain_title_alone(self):
        for t in ("Jungle night sounds from a stilt hut, Borneo", "Shinjuku FM: soft lofi and smooth jazz",
                  "Lo-Fi beats - rainy night in the Olive grove", "Alive: Delivery of the deliverance",
                  "Lofi hip hop radio: beats to sleep and chill to", "Rain on a tin roof | 10 hours"):
            self.assertEqual(publish.clean_title(t), t)

    def test_clean_title_keeps_japanese_and_korean(self):
        self.assertEqual(publish.clean_title("焚き火の音・森の夜々「ーー」"), "焚き火の音・森の夜々「ーー」")
        self.assertEqual(publish.clean_title("\U0001F525 焚き火 LIVE 24/7 | 森の夜"), "焚き火 | 森の夜")
        self.assertEqual(publish.clean_title("\U0001F534 LIVE 모닥불 소리 · 비 오는 밤 \U0001F327️"), "모닥불 소리 · 비 오는 밤")

    def test_clean_title_drops_empty_brackets_and_the_yt_dlp_live_stamp(self):
        self.assertEqual(publish.clean_title("Campfire 【LIVE】 (24/7) [live] \U0001F525"), "Campfire")
        # yt-dlp appends the time to a live stream's title (its fulltitle doesn't); the worker stores that one.
        self.assertEqual(publish.clean_title(CAMPFIRE + " 2026-11-15 17:00"), publish.clean_title(CAMPFIRE))
        once = publish.clean_title(CAMPFIRE)
        self.assertEqual(publish.clean_title(once), once)  # cleaning twice changes nothing

    def test_clean_title_tidies_punctuation_a_marker_leaves(self):
        # Stream titles from the monitor's seed data (2026-10-17).
        self.assertEqual(publish.clean_title("LIVE! View of the Milky Way Galaxy \U0001F30C"), "View of the Milky Way Galaxy")
        self.assertEqual(publish.clean_title("ISS LIVE, with crew audio"), "ISS, with crew audio")
        self.assertEqual(publish.clean_title("Finse station - Live"), "Finse station")
        self.assertEqual(publish.clean_title("LIVE: Campfire · rain"), "Campfire · rain")
        self.assertEqual(publish.clean_title("Campfire: LIVE · rain"), "Campfire · rain")
        self.assertEqual(publish.clean_title("Campfire (24/7 Stream)"), "Campfire (Stream)")
        self.assertEqual(publish.clean_title("Rain (live)"), "Rain")

    def test_clean_title_keeps_live_inside_a_hyphen_compound(self):
        for t in ("Live-stream of rain", "Rain to re-live the night", "LIVE-STREAM: rain"):
            self.assertEqual(publish.clean_title(t), t)

    def test_live_is_removed_only_where_it_is_a_marker(self):
        # Round 2 (coordinator, 2026-11-15): "Long Live the Night" must stay.
        for t in ("Long Live the Night", "Alive at Night", "Olive Grove", "live music", "Campfire (Live Stream)",
                  "Osaka Loop Line live camera", "ISS live, with crew audio"):
            self.assertEqual(publish.clean_title(t), t)
        self.assertEqual(publish.clean_title("LIVE 24/7"), "")
        self.assertEqual(publish.clean_title("\U0001F534 LIVE"), "")
        self.assertEqual(publish.clean_title("Live Now: 24/7 Iceberg Cam"), "Iceberg Cam")
        self.assertEqual(publish.clean_title("Live 24/7 rain on a tin roof"), "rain on a tin roof")
        self.assertEqual(publish.clean_title("Live: Campfire"), "Campfire")

    def test_row_title_is_the_first_part(self):
        # Owner, 2026-11-15, on the long campfire title: "B. First part only".
        self.assertEqual(publish.row_title(CAMPFIRE), "Lonely Lakeside Campfire")
        self.assertEqual(publish.row_title("Iceberg Cam of Ilulissat, Greenland in 4K Ultra HD"), "Iceberg Cam of Ilulissat, Greenland in 4K Ultra HD")
        self.assertEqual(publish.row_title("Lo-Fi beats - rainy night"), "Lo-Fi beats")  # a dash splits only with spaces round it
        self.assertEqual(publish.row_title("Ancient Empires for Sleep — Calm History Radio"), "Ancient Empires for Sleep")
        self.assertEqual(publish.row_title("\U0001F534 LIVE · | Campfire night – rain"), "Campfire night")  # first part with words
        self.assertEqual(publish.row_title("Campfire: | rain"), "Campfire")
        self.assertEqual(publish.row_title("\U0001F525 焚き火 LIVE 24/7 ｜ 森の夜"), "焚き火")
        self.assertEqual(publish.row_title("焚き火の音・森の夜"), "焚き火の音・森の夜")  # the katakana middle dot is not a separator
        self.assertEqual(publish.row_title("\U0001F534 LIVE 24/7 \U0001F525"), "")
        self.assertEqual(publish.row_title(None), "")

    # Round 3: the verifier's findings on 776344a (verify.md, 2026-11-15), checked against dac03d5.
    def test_a_removed_marker_leaves_no_doubled_or_dangling_separator_or_empty_pair(self):
        for raw, want in (("Rain・LIVE・Night", "Rain・Night"), ("LIVE・Rain", "Rain"), ("Rain、LIVE、Night", "Rain、Night"),
                          ("Rain，LIVE，Night", "Rain，Night"), ("Rain / LIVE / Night", "Rain / Night"), ("Rain ~ LIVE ~ Night", "Rain ~ Night"),
                          ("Rain ¦ LIVE ¦ Night", "Rain ¦ Night"), ("Rain 丨 LIVE 丨 Night", "Rain 丨 Night"),
                          ("Rain ⋆ LIVE ⋆ Night", "Rain ⋆ Night"), ("Rain ｰ LIVE ｰ Night", "Rain ｰ Night"),
                          ('"LIVE" Rain', "Rain"), ("Rain {LIVE}", "Rain"), ("《LIVE》Rain", "Rain"), ("〈LIVE〉Rain", "Rain"),
                          ("“LIVE” Rain", "Rain"), ("«LIVE» Rain", "Rain"), ("Rain: LIVE: Night", "Rain: Night"),
                          ("Now Live: rain", "Now Live: rain"), ("Rain | | | Night", "Rain | Night"), ("Rain • • Night", "Rain • Night")):
            self.assertEqual(publish.clean_title(raw), want, raw)

    def test_no_published_title_starts_or_ends_with_a_separator_or_holds_an_empty_pair_or_a_doubled_one(self):
        from slotmon import titles
        seps = set(titles.SEPS)
        raws = [a + " " + m + " " + b for m in ("LIVE", "\U0001F525", "24/7", "(LIVE)", '"LIVE"', "《LIVE》") for a, b in (("", "Rain"), ("Rain", ""), ("Rain", "Night"))]
        raws += [a + s + m + s + b for s in titles.SEPS + " " for m in ("LIVE", "\U0001F525") for a, b in (("Rain", "Night"), ("", "Rain"), ("Rain", ""))]
        for raw in raws:
            for out in (publish.clean_title(raw), publish.row_title(raw)):
                if not out:
                    continue
                self.assertFalse(out[0] in seps or out[-1] in seps, (raw, out))
                squeezed = [c for c in out if not c.isspace()]
                self.assertFalse(any(a == b and a in seps for a, b in zip(squeezed, squeezed[1:])), (raw, out))
                self.assertFalse(titles.EMPTY_PAIRS.search(out), (raw, out))

    def test_which_separators_split_a_part(self):
        for raw, want in (("Rain ¦ Night", "Rain"), ("Rain丨Night", "Rain"), ("Rain ⋆ Night", "Rain"), ("Rain / Night", "Rain"),
                          ("Rain ~ Night", "Rain"), ("Rain ‖ Night", "Rain"), ("Rain／Night", "Rain"),
                          ("chill music to study/relax to", "chill music to study/relax to"), ("安眠・リラックス", "安眠・リラックス"),
                          ("Rain、Night", "Rain、Night"), ("Rain, Night: Sleep", "Rain, Night: Sleep")):
            self.assertEqual(publish.row_title(raw), want, raw)

    def test_live_inside_another_token_stays(self):
        for t in ("live.com rain", "#live rain", "@live rain", "Live—stream", "live_stream"):
            self.assertEqual(publish.clean_title(t), t)

    def test_a_word_is_never_split_and_control_characters_go(self):
        self.assertEqual(publish.clean_title("Cam­pfire night"), "Campfire night")  # soft hyphen: deleted, not a space
        self.assertEqual(publish.clean_title("می‌خوابم"), "می‌خوابم")  # Persian ZWNJ stays
        self.assertEqual(publish.clean_title("\U0001F469‍\U0001F525 Rain"), "Rain")  # a ZWJ left by removed emoji goes
        self.assertEqual(publish.clean_title("Rain\x00Night"), "Rain Night")
        self.assertEqual(publish.clean_title("\x07Rain\x1b"), "Rain")
        self.assertFalse(any(unicodedata.category(c) == "Cc" for c in publish.clean_title("Rain\x1b[31mRed\x7f")))

    def test_fullwidth_and_styled_markers_are_caught(self):
        self.assertEqual(publish.clean_title("ＬＩＶＥ Campfire"), "Campfire")
        self.assertEqual(publish.clean_title("\U0001D40B\U0001D408\U0001D415\U0001D404 Campfire"), "Campfire")
        self.assertEqual(publish.clean_title("Ｌｉｖｅ ２４／７ 焚き火"), "焚き火")

    def test_angle_brackets_never_reach_the_title(self):
        self.assertEqual(publish.clean_title("<b>Rain</b> night"), "Rain night")
        self.assertEqual(publish.clean_title("<color=red>RED ALERT</color>"), "RED ALERT")
        for t in ("Rain >> Night << Sleep", "Rain <3 Night", "a < b > c"):
            self.assertFalse(set("<>") & set(publish.row_title(t)), t)

    def test_a_banned_word_in_the_followed_title_falls_back(self):
        self.checked("OLDOLDOLD01", "\U0001F534 ASMR rain sounds · LIVE 24/7")
        self.assertEqual(self.doc()["slots"]["radio"], {"title": "Radio fallback"})
        self.assertEqual(publish.row_title("Rain sounds · asmr tingles"), "")  # in a later part too
        self.assertEqual(publish.row_title("ＡＳＭＲ rain"), "")  # fullwidth

    def test_a_long_title_is_capped_at_a_whole_word(self):
        from slotmon import titles
        long = publish.row_title("Rain " * 60)
        self.assertLessEqual(titles._units(long), titles.CAP_UNITS)
        self.assertTrue(long.endswith("Rain") and long == long.strip(), long)
        cjk = publish.row_title("焚き火" * 40)
        self.assertEqual(titles._units(cjk), titles.CAP_UNITS)  # no spaces: cut where it is full
        self.assertEqual(publish.row_title("Iceberg Cam of Ilulissat, Greenland in 4K Ultra HD"), "Iceberg Cam of Ilulissat, Greenland in 4K Ultra HD")
        # A seed title (2026-10-17) whose cut fell after a lone "+": no mark is left at the end.
        self.assertEqual(publish.row_title("Marble Run Race HABA Slope + Cuboro + Bornelund Quadrilla + Transparent pipe"),
                         "Marble Run Race HABA Slope + Cuboro + Bornelund Quadrilla")

    # Round 4: the verifier's round 2 on 24849df (verify.md "Round 2").
    def test_a_split_or_a_cut_never_leaves_a_pair_open(self):
        for raw, want in (("Night Train (Tokyo – Osaka) ambience", "Night Train (Tokyo – Osaka) ambience"),
                          ("Rain (Tokyo - Osaka)", "Rain (Tokyo - Osaka)"),
                          ("Cozy Cabin (Rain · Fireplace · Snow)", "Cozy Cabin (Rain · Fireplace · Snow)"),
                          ("Lakeside [4K | HDR] Campfire", "Lakeside [4K | HDR] Campfire"),
                          ("Campfire 【焚き火 | 雨音】", "Campfire 【焚き火 | 雨音】"),
                          ("Rain “Night · Sleep”", "Rain “Night · Sleep”"),
                          ("Night Train (Tokyo – Osaka) · rain", "Night Train (Tokyo – Osaka)"),
                          # a seed title (2026-10-17) the cap used to cut inside its brackets: cut back to before the opener
                          ("Live Video from the International Space Station (Official NASA Stream)", "Live Video from the International Space Station"),
                          ("Rain (Tokyo", "Rain Tokyo"), ("Rain) Night", "Rain Night")):  # a title that came unbalanced
            self.assertEqual(publish.row_title(raw), want, raw)

    def test_no_published_title_holds_an_unclosed_or_unopened_bracket_or_quote(self):
        pairs = {"(": ")", "[": "]", "{": "}", "【": "】", "「": "」", "『": "』", "（": "）", "〔": "〕",
                 "《": "》", "〈": "〉", "«": "»", "‹": "›", "“": "”", "„": "“"}

        def unpaired(t):  # written apart from titles._unmatched on purpose
            stack = []
            for c in t:
                if c == '"':
                    stack.pop() if stack and stack[-1] == '"' else stack.append(c)
                elif stack and pairs.get(stack[-1]) == c:
                    stack.pop()
                elif c in pairs:
                    stack.append(c)
                elif c in pairs.values():
                    return True
            return bool(stack)
        raws = set()
        for p in __import__("glob").glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed", "*.json")):
            with open(p, encoding="utf-8") as f:
                d = json.load(f)
            raws |= {o["title"] for o in d.get("observations", []) + d.get("flash", []) if o.get("title")}
        self.assertGreater(len(raws), 200)
        for o, c in list(pairs.items()) + [('"', '"')]:
            for sep in (" · ", " | ", " - ", " – ", "｜", " / "):
                raws |= {"Rain %sTokyo%sOsaka%s night" % (o, sep, c), "%sRain%sNight%s" % (o, sep, c), "Night%s%sRain%s" % (sep, o, c),
                         "Rain %s%s%s more" % (o, "word " * 20, c), "x" * 55 + " %sRain at night%s" % (o, c), "Rain%s night%sNight" % (c, sep),
                         "Rain %s night%s%s" % (o, sep, "LIVE"), "%s%s%s Rain" % (o, "\U0001F525", c)}
        # Fuzz finds on d7e4ec4 (scratch/r4/fuzz_all.py, 2026-11-15): dropping one character undid another rule.
        raws |= {"Rain 〈)〉 night", "LE !V7 （き /”）丨 i", "丨ON›]L • .〕{丨〕 —‘;w〉› ！ 2o(V』«4",
                 "4? !h〉〕\"（(火 / 『ｰ、“：]", "ei【》 】 「|‘⋆", "〔,き』/ ! 〕／[2nR2—L'『》R《'Lき」)き火"}
        seps = set(__import__("slotmon.titles", fromlist=["SEPS"]).SEPS)
        for raw in raws:
            out = publish.row_title(raw)
            self.assertFalse(unpaired(out), (raw, out))
            self.assertFalse(out and (out[0] in seps or out[-1] in seps), (raw, out))
            self.assertFalse(any(o + c in out.replace(" ", "") for o, c in list(pairs.items()) + [("‘", "’")]), (raw, out))

    def test_a_bare_first_part_is_skipped(self):
        for raw, want in (("A · Rainy night by the lake", "Rainy night by the lake"), ("4K · Rainy night", "Rainy night"),
                          ("2024 | Rain", "Rain"), ("Ah | Rainy night", "Rainy night"), ("Cafe · Work · Study", "Cafe"),
                          ("2024 | 4K", ""), ("雨音 | night", "雨音")):
            self.assertEqual(publish.row_title(raw), want, raw)

    def test_stacked_marks_are_capped_and_a_bidi_control_never_joins_two_words(self):
        self.assertEqual(publish.clean_title("n" + "́" * 30 + " rain"), "ń́ rain")
        self.assertEqual(publish.clean_title("Rain‮Night‬"), "Rain Night")
        self.assertEqual(publish.clean_title("שלום‏."), "שלום.")  # an RLM before a stop: deleted
        self.assertEqual(publish.clean_title("น้ำ"), "น้ำ")  # Thai: one mark stays

    def test_the_cap_cuts_a_cjk_run_by_units_instead_of_dropping_it(self):
        from slotmon import titles
        out = publish.row_title("雨の夜 " + "焚き火の音" * 10)
        self.assertTrue(out.startswith("雨の夜 焚き火"), out)
        self.assertGreaterEqual(titles._units(out), titles.CAP_UNITS - 1)
        self.assertEqual(publish.row_title("Rain " + "焚" * 40), "Rain " + "焚" * 29)

    def test_a_title_that_raises_falls_back_and_the_pass_still_publishes_every_slot(self):
        self.checked("OLDOLDOLD01", CAMPFIRE)

        def boom(raw):
            raise ValueError("bad title")
        with mock.patch.object(publish, "row_title", boom), mock.patch.object(config, "DATA_DIR", self.tmp), \
                mock.patch.object(config, "PUBLISH", False), mock.patch.object(publish, "build_sheet", lambda slots, cur: (b"", [])):
            self.assertEqual(self.doc()["slots"], {"cam": {"title": "Tokyo cam"}, "radio": {"title": "Radio fallback"}})
            core.publish_pass(self.con, SLOTS, FOLLOW)
        with open(os.path.join(self.tmp, "out", config.STATUS_FILE), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["slots"], {"cam": {"title": "Tokyo cam"}, "radio": {"title": "Radio fallback"}})

    def test_setting_off_publishes_what_it_did_before(self):
        self.checked("OLDOLDOLD01", CAMPFIRE, OVERRIDES)
        self.checked("CAMCAMCAM01", CAMPFIRE, OVERRIDES)
        self.assertEqual(self.doc(OVERRIDES), publish.status_doc(SLOTS, core.slot_rows(self.con), OVERRIDES))
        self.assertEqual(self.doc(OVERRIDES), {"notice": "", "slots": {"cam": {"title": "Tokyo cam"}}})

    def test_setting_on_publishes_the_cleaned_stream_title(self):
        self.checked("OLDOLDOLD01", CAMPFIRE)
        self.assertEqual(self.doc()["slots"], {"cam": {"title": "Tokyo cam"}, "radio": {"title": "Lonely Lakeside Campfire"}})
        self.assertNotIn("title_from", json.dumps(self.doc()))  # a monitor setting, never published

    def test_no_stored_title_falls_back_to_the_override_then_the_baked_title(self):
        self.assertEqual(self.doc()["slots"]["radio"], {"title": "Radio fallback"})  # no check yet: no stored title
        self.checked("OLDOLDOLD01", "\U0001F534 LIVE 24/7 \U0001F525")  # cleans to nothing
        self.assertEqual(self.doc()["slots"]["radio"], {"title": "Radio fallback"})
        bare = {"notice": "", "slots": {"radio": {"title_from": "stream"}}}
        self.assertNotIn("radio", self.doc(bare)["slots"])  # the world's baked title, as with no override
        self.checked("OLDOLDOLD01", "\U0001F534 Sleep radio · LIVE 24/7", bare)
        self.assertNotIn("radio", self.doc(bare)["slots"])  # cleans to the baked title: nothing to write

    def test_after_a_swap_the_title_follows_the_new_stream_not_the_candidate(self):
        self.checked("OLDOLDOLD01", "\U0001F534 sleep lofi radio 24/7")
        self.assertEqual(self.doc()["slots"]["radio"], {"title": "sleep lofi radio"})
        self.api.world["OLDOLDOLD01"] = st("OLDOLDOLD01", "ended", title="sleep lofi radio 24/7")
        self.api.world["NEWNEWNEW01"] = st("NEWNEWNEW01", "live", title="\U0001F534 sleep lofi radio 24/7 relaxing", started=time.time() - 600)
        self.live_ids["UClofi"] = ["NEWNEWNEW01"]
        core.check_pass(self.con, self.api, FOLLOW)
        cand = [j for j in self.jobs() if j["reason"] == "candidate"]
        self.assertEqual([j["video_id"] for j in cand], ["NEWNEWNEW01"])
        # Waiting for its flash check: hidden, and still the title of the stream the slot plays.
        self.assertEqual(self.doc()["slots"]["radio"], {"hidden": True, "title": "sleep lofi radio"})
        r = {"id": cand[0]["id"], "video_id": "NEWNEWNEW01", "runner": "optiplex", "ts": time.time(), "live_status": "is_live",
             "height": 1080, "format_id": "96", "title": "\U0001F534 sleep lofi radio 24/7 relaxing 2026-11-15 17:00",
             "flash": {"verdict": "pass", "max_fps": 0, "regions": [0] * 5, "frames": 450, "mean_luminance": 0.05}}
        core.submit_results(self.con, self.api, [r], FOLLOW)
        self.assertEqual(self.slot("radio")["current_video"], "NEWNEWNEW01")
        self.assertEqual(self.doc()["slots"]["radio"], {"title": "sleep lofi radio relaxing"})  # yt-dlp's stamped title, same text
        core.check_pass(self.con, self.api, FOLLOW)  # the next pass stores the API's title again: no change, no commit
        self.assertEqual(self.doc()["slots"]["radio"], {"title": "sleep lofi radio relaxing"})

    def test_publish_pass_writes_the_followed_title(self):
        self.checked("OLDOLDOLD01", CAMPFIRE)
        with mock.patch.object(config, "DATA_DIR", self.tmp), mock.patch.object(config, "PUBLISH", False), \
                mock.patch.object(publish, "build_sheet", lambda slots, cur: (b"", [])):
            core.publish_pass(self.con, SLOTS, FOLLOW)
        with open(os.path.join(self.tmp, "out", config.STATUS_FILE), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["slots"]["radio"], {"title": "Lonely Lakeside Campfire"})


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

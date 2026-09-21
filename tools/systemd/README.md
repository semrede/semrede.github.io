# Counting the visits on a timer

GitHub Actions is supposed to run `tools/stats.mjs run` every hour
(`.github/workflows/stats.yml`), but GitHub's scheduler is not reliable: on this
repository it delivered no scheduled run at all for six hours, while the same
workflow ran fine when triggered by hand. So the count also runs locally.

Install (once):

```bash
cp tools/systemd/semrede-stats.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now semrede-stats.timer
loginctl enable-linger "$USER"      # so it also runs while logged out
```

Check on it:

```bash
systemctl --user list-timers semrede-stats.timer
journalctl --user -u semrede-stats.service -n 40
```

Remove it:

```bash
systemctl --user disable --now semrede-stats.timer
rm ~/.config/systemd/user/semrede-stats.*
```

Running both the timer and the workflow is harmless: an aggregate is an
addressable event, so publishing the same day again replaces it.

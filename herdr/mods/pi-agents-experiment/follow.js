// Keeps an open preview's output current. It reads every two seconds while
// the saved snapshot or the run's status record says the run is working, and
// not after both have settled. At most one read is in flight and one timer
// pending. Closing cancels the timer and discards a read already started.
export class OutputFollower {
  constructor(read, live) {
    this.read = read;
    this.live = live;
    this.loading = false;
    this.closed = false;
  }

  // Render passes the run's record state on every redraw. Only a change to
  // working wakes a settled preview (a run restarted with `subagent-send`), so
  // a snapshot that still says done cannot turn redraws into reads.
  observe(cx, live) {
    const woke = live === "working" && this.live !== "working";
    this.live = live;
    if (woke) this.refresh(cx);
  }

  refresh(cx) {
    if (this.closed || this.loading) return;
    this.timer?.cancel();
    this.timer = undefined;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const data = await this.read();
        if (this.closed) return;
        this.data = data;
        this.error = undefined;
      } catch (error) {
        this.error = error;
      } finally {
        this.loading = false;
        if (!this.closed) {
          const active =
            this.data?.status === "running" || this.live === "working";
          if (!this.error && active) {
            this.timer = cx.timer.after(2000, (cx) => this.refresh(cx));
          }
          cx.notify();
        }
      }
    });
  }

  close() {
    this.closed = true;
    this.timer?.cancel();
  }
}

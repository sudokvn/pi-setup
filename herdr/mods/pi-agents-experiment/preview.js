import { div } from "gpui-kit";
import { TextView, h_flex, v_flex } from "gpui-base";
import { props, theme, exec, run, closeOverlay, terminals } from "herdr";
import { OutputFollower } from "./follow.js";
import { outputRequest, outputStatus } from "./output.js";

const READ_ERROR =
  "Could not read this run’s output. Check the machine connection and try Refresh. If Pi uses a custom state directory, use /subagents in the parent.";

// Hosted by the Agents mod so the preview shares its status renderer. It is
// read-only, not a pretend child terminal. See OutputFollower for when it
// reads again.
export class OutputPreview {
  init(cx) {
    this.query = props().preview;
    const { parent, id, state } = this.query;
    this.follower = new OutputFollower(async () => {
      const request = outputRequest(parent, id);
      const result = await exec(request.command, request.args, request.options);
      if (result.code !== 0) throw new Error("Snapshot unavailable");
      const data = JSON.parse(result.stdout);
      if (typeof data.text !== "string" || !Array.isArray(data.tools)) {
        throw new Error("Invalid output response");
      }
      return data;
    }, state);
    this.follower.refresh(cx);
  }

  close() {
    this.follower.close();
  }

  render(cx, status) {
    const t = theme();
    const { parent, id, name } = this.query;
    // terminals() is live, so this runs whenever the parent's records change.
    const record = terminals().find(
      (terminal) => terminal.address === parent && terminal.state === "live",
    )?.records?.[`pi-subagents/${id}`];
    this.follower.observe(cx, record?.state);
    const { data, loading } = this.follower;
    const error = this.follower.error ? READ_ERROR : undefined;
    const overlay = props().overlay;
    const button = (id, label, onClick) =>
      div()
        .id(id)
        .px(8)
        .py(2)
        .rounded(5)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(36)
          .px(12)
          .gap(8)
          .flex_none()
          .items_center()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(
            status(
              t,
              data
                ? outputStatus(data.status)
                : this.query.state === "error"
                  ? "blocked"
                  : (this.query.state ?? "idle"),
            ),
          )
          .child(div().min_w(0).truncate().font_semibold().child(name))
          .child(
            div()
              .flex_none()
              .text_size(11)
              .text_color(t.dim)
              .child(`read-only · from ${parent}`),
          )
          .child(div().flex_1())
          .child(
            button(
              "preview-refresh",
              loading ? "Loading…" : "Refresh",
              (_event, cx) => this.follower.refresh(cx),
            ),
          )
          .child(
            button("preview-parent", "↗ parent", () => {
              run("pane.focus", { terminal: parent });
              if (overlay) closeOverlay(overlay);
            }),
          )
          .when(Boolean(overlay), (el) =>
            el.child(button("preview-close", "✕", () => closeOverlay(overlay))),
          ),
      )
      .when(Boolean(data?.tools.length), (el) =>
        el.child(
          div()
            .px(16)
            .py(6)
            .flex_none()
            .text_size(11)
            .text_color(t.muted)
            .child(`Using: ${data.tools.join(", ")}`),
        ),
      )
      .when(Boolean(error), (el) =>
        el.child(
          div().px(16).py(8).flex_none().text_color(t.blocked).child(error),
        ),
      )
      .when(Boolean(data?.truncated), (el) =>
        el.child(
          div()
            .px(16)
            .py(6)
            .flex_none()
            .text_color(t.muted)
            .child("Output shortened to 256k characters."),
        ),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .p(16)
          .child(
            TextView.markdown(
              "pi-subagent-output",
              data?.text ||
                (loading ? "Loading output…" : "No assistant output yet."),
            )
              .selectable(true)
              .scrollable(true)
              .size_full(),
          ),
      );
  }
}

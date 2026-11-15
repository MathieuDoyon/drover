// Drover New task: no UI of its own. Bound to a key (keys.json: "mod.open:drover-newtask"), it opens the Create task dialog
// of drover-todos, unless one is already open (the guard in shared state: see io.js), and closes its own empty overlay.
// Turned on and off from drover-config (Shortcuts).
import { View, div } from "gpui-kit";
import { props, closeOverlay, shared } from "herdr";
import { edit, guardLive, reserveCreate, NEWTASK_KEY } from "./io.js";

export default class NewTask extends View {
  init(_props, _cx) {
    const overlay = props()?.overlay; // null when the host only checks the mod
    if (overlay == null) return;
    try {
      // Nothing is awaited between the check and the reservation, so two presses cannot both pass it.
      if (!guardLive(shared(NEWTASK_KEY))) {
        reserveCreate();
        edit(null, "todo"); // records { id, at }
      }
    } finally {
      closeOverlay(overlay);
    }
  }

  render(_cx) {
    return div();
  }
}

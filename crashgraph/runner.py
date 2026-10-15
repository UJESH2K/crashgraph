"""One attempt, start to finish. Shared by the CLI and the live control room."""
import time

from .sim import Flight


def run_episode(flight: Flight, pilot, mem, n, *, learn=True, epsilon=None, seed=None,
                on_frame=None, control=None, frame_every=1, realtime=False):
    """control: object with .interrupt (bool) and .pending_gust (None|float) checked each frame,
    and .paused (bool). on_frame(frame_list, step, q, action, situation_label)."""
    obs = flight.reset(seed=seed)
    eps = pilot.epsilon_for(n) if epsilon is None else epsilon
    pilot.begin(eps, learn=learn)
    score, steps, outcome = 0.0, 0, None
    a, q = pilot.act(obs)
    frames = []
    t_next = time.perf_counter()
    while True:
        if control is not None:
            while control.paused and not control.interrupt and not control.stop:
                time.sleep(0.05)
            if control.interrupt or control.stop:
                outcome = "interrupted"
                break
            if control.pending_gust is not None:
                flight.gust(control.pending_gust)
                control.pending_gust = None
        obs2, r, term, trunc = flight.step(a)
        score += r
        steps += 1
        fr = flight.frame(a)
        frames.append(fr)
        pilot.observe(r, obs2, term)
        if on_frame is not None and steps % frame_every == 0:
            on_frame(fr, steps, q, a, pilot.path[-1]["label"] if pilot.path else "")
        if realtime:
            t_next += 1 / 50
            delay = t_next - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                t_next = time.perf_counter()
        if term or trunc:
            outcome = flight.outcome(obs2, r, term, trunc)
            break
        a, q = pilot.act_next(obs2)
    written = pilot.flush()   # an interrupted attempt still teaches what it saw up to the interrupt
    ep = {"n": n, "score": round(score, 2), "outcome": outcome, "steps": steps, "fuel": round(flight.fuel, 2),
          "epsilon": round(eps, 4), "learned": bool(learn), "gusts": flight.gusts, "path": pilot.path}
    mem.record_episode(ep)
    ep["tiles_written"] = written
    ep["graph_reads"] = pilot.graph_reads
    ep["frames"] = frames
    return ep

#!/usr/bin/env python3
"""Compare TODO refresh policies on an already-running, local MLX-LM server.

The fixture comes from the Rust Harness regression test (see README.md).
Only synthetic fixture messages are sent. No tools are executed, servers
restarted, or packages installed. Use the server's already-loaded default;
requesting another model can cause the server to load or download it.
"""

import argparse
import copy
import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("The local benchmark does not follow redirects")


def legacy_next(messages):
    """Reconstruct the old policy: replace the first snapshot, omit the new one."""
    result = copy.deepcopy(messages)
    snapshots = [
        i for i, m in enumerate(result)
        if m.get("role") == "system" and m.get("content", "").startswith("[TODO list]")
    ]
    if len(snapshots) != 2 or snapshots[-1] != len(result) - 1:
        raise ValueError("Expected the Harness fixture with one appended TODO update")
    result[snapshots[0]]["content"] = result[snapshots[-1]]["content"]
    result.pop()
    return result


def isolated(messages, nonce):
    result = copy.deepcopy(messages)
    # A distinct early token prevents reuse between samples/policies; only
    # each sample's warm -> next transition can share its long prefix.
    result[0]["content"] = f"Benchmark sample {nonce}.\n" + result[0]["content"]
    return result


def infer(opener, endpoint, model, messages, tools, max_tokens=8):
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": 0,
        "max_tokens": max_tokens,
        # Hold thinking constant in this latency experiment only. This does
        # not alter Klide's model settings or the running server's defaults.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if tools:
        payload["tools"] = tools
    request = urllib.request.Request(
        endpoint, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    started = time.perf_counter()
    first = None
    usage = {}
    content = []
    completed = False
    try:
        response = opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        detail = error.read(2000).decode(errors="replace")
        raise RuntimeError(f"MLX HTTP {error.code}: {detail}") from error
    with response:
        for raw in response:
            if time.perf_counter() - started > 120:
                raise TimeoutError("Request exceeded the benchmark deadline")
            line = raw.decode().strip()
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                completed = True
                break
            event = json.loads(data)
            if "error" in event:
                raise RuntimeError(str(event["error"]))
            if event.get("usage"):
                usage = event["usage"]
            for choice in event.get("choices", []):
                delta = choice.get("delta", {})
                if first is None and any(delta.get(k) for k in (
                    "content", "reasoning_content", "reasoning", "tool_calls",
                )):
                    first = time.perf_counter()
                content.append(delta.get("content") or "")
    if not completed:
        raise RuntimeError("Incomplete SSE response; refusing to record a successful sample")
    return {
        "ttft_ms": round((first - started) * 1000, 2) if first else None,
        "request_ms": round((time.perf_counter() - started) * 1000, 2),
        "prompt_tokens": usage.get("prompt_tokens"),
        "cached_tokens": usage.get("prompt_tokens_details", {}).get("cached_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "text": "".join(content),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8080/v1/chat/completions")
    parser.add_argument("--model", default="default_model")
    parser.add_argument("--repeats", type=int, choices=range(1, 11), default=1,
                        help="Use a byte-budgeted server for repeated trials (default: 1)")
    args = parser.parse_args()
    url = urllib.parse.urlparse(args.endpoint)
    if url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1"):
        parser.error("Only an HTTP loopback endpoint is allowed")
    if url.username or url.password:
        parser.error("Do not put credentials in the endpoint")
    fixture = json.loads(args.fixture.read_text())
    variants = {"rewrite": legacy_next(fixture["next"]), "append": fixture["next"]}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    report = {
        "model_request": args.model, "endpoint": args.endpoint,
        "complete": False,
        "repeats": args.repeats, "samples": [], "status_smoke": {},
        "scope": "Synthetic Harness replay; not a coding-quality or end-to-end task benchmark",
    }
    # Exclude model startup / initial Metal compilation from reported samples.
    infer(opener, args.endpoint, args.model, [{"role": "user", "content": "Say OK."}], None)
    for iteration in range(args.repeats):
        order = ("rewrite", "append") if iteration % 2 == 0 else ("append", "rewrite")
        for policy in order:
            nonce = uuid.uuid4().hex
            warm = infer(opener, args.endpoint, args.model,
                         isolated(fixture["warm"], nonce), fixture.get("tools"))
            measured = infer(opener, args.endpoint, args.model,
                             isolated(variants[policy], nonce), fixture.get("tools"))
            sample = {"policy": policy, "iteration": iteration + 1,
                      "warm": warm, "next": measured}
            report["samples"].append(sample)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
            print(json.dumps(sample), flush=True)
    for policy, messages in variants.items():
        prompt = isolated(messages, uuid.uuid4().hex)
        prompt.append({"role": "user", "content": (
            "According to the latest TODO state, is T1 completed? "
            "Answer exactly DONE if completed or PENDING if not."
        )})
        smoke = infer(opener, args.endpoint, args.model, prompt, None, max_tokens=32)
        smoke["passed"] = smoke["text"].strip() == "DONE"
        report["status_smoke"][policy] = smoke
    report["medians"] = {}
    for policy in variants:
        samples = [s["next"] for s in report["samples"] if s["policy"] == policy]
        report["medians"][policy] = {
            key: statistics.median(values) if len(values) == len(samples) else None
            for key in ("ttft_ms", "request_ms", "prompt_tokens", "cached_tokens")
            for values in [[s[key] for s in samples if s[key] is not None]]
        }
    report["complete"] = True
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"medians": report["medians"], "status_smoke": report["status_smoke"]}, indent=2))


if __name__ == "__main__":
    main()

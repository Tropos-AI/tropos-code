---
name: flask-json-service
description: Use when writing, running or testing a small Flask JSON API, or any Python HTTP service that must run in the background in a container.
---
# Flask JSON API as a background service

Request handling
- request.get_json(silent=True) returns None for a wrong Content-Type or malformed JSON instead of raising. Return 400 with {"error": ...} in that case.
- Check isinstance(data, dict): a JSON list is valid JSON with the wrong shape.
- Check each field for presence, type and non-emptiness, with a distinct message per failure so each case can be tested.
- If the API promises JSON errors, add @app.errorhandler for 404 and 405 that return jsonify({"error": ...}) with the same status.
- Restrict methods explicitly with @app.route(path, methods=["POST"]).

Binding
- app.run(host="0.0.0.0", port=N) accepts connections on all interfaces; the default 127.0.0.1 does not.
- Confirm by calling the container's non-loopback address (hostname -I, or the URL in the startup log).

Background
- Check what exists first: command -v ps curl wget. A missing command fails its own call.
- Start with: cd to the app directory; nohup python3 app.py > service.log 2>&1 & echo $! > service.pid. Keep the launch separate from the liveness check.
- Readiness: poll the port with socket.create_connection(("127.0.0.1", PORT)) under a deadline, rather than relying on a fixed sleep.
- Liveness without ps: kill -0 "$(cat service.pid)".
- Stop with kill "$(cat service.pid)" and confirm the port closes.
- Read service.log after any failure.

Testing
- Cover: a valid request for each label; each missing, wrong-type and empty field; invalid JSON; a wrong Content-Type; a list body; a wrong method; an unknown path.
- Use python3 urllib for requests when curl is absent.
- Also call the non-loopback address to confirm the 0.0.0.0 binding.
- Check the access log for the status codes you expected.

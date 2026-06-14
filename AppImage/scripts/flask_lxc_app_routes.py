"""
ProxMenux — LXC app update REST endpoints.
"""

from flask import Blueprint, jsonify, request

import lxc_app_updates as lau
from jwt_middleware import require_auth

lxc_app_bp = Blueprint("lxc_app", __name__)


@lxc_app_bp.route("/api/lxc-app-catalog", methods=["GET"])
@require_auth
def catalog():
    return jsonify({"apps": lau.catalog_list()})


@lxc_app_bp.route("/api/lxc-app/settings", methods=["GET"])
@require_auth
def settings_get():
    return jsonify(lau.get_settings())


@lxc_app_bp.route("/api/lxc-app/settings", methods=["POST"])
@require_auth
def settings_set():
    data = request.get_json(silent=True) or {}
    lau.set_github_pat(data.get("github_pat"))
    return jsonify({"success": True, **lau.get_settings()})


@lxc_app_bp.route("/api/vms/<int:vmid>/app", methods=["GET"])
@require_auth
def app_get(vmid):
    return jsonify({"assignment": lau.get_assignment(vmid)})


@lxc_app_bp.route("/api/vms/<int:vmid>/app", methods=["POST"])
@require_auth
def app_set(vmid):
    data = request.get_json(silent=True) or {}
    try:
        spec = lau.set_assignment(vmid, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    result = lau.check_lxc_app(vmid, store=True)
    return jsonify({"success": True, "assignment": spec, "app_update": result})


@lxc_app_bp.route("/api/vms/<int:vmid>/app", methods=["DELETE"])
@require_auth
def app_delete(vmid):
    lau.clear_assignment(vmid)
    return jsonify({"success": True})


@lxc_app_bp.route("/api/vms/<int:vmid>/app/check", methods=["POST"])
@require_auth
def app_check(vmid):
    result = lau.check_lxc_app(vmid, store=True)
    if result is None:
        return jsonify({"error": "no app assigned"}), 404
    return jsonify({"app_update": result})

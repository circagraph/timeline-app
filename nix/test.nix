# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# The NixOS test of services.circagraph (#461): a machine with the module and nginx in
# front, whose server answers through nginx; PostgreSQL has pgmp; the client (test-client.mjs)
# signs in as the configured administrator, saves, searches and downloads a timeline as .och;
# the generated key survives a restart; and the syslog receiver runs as its own user, which
# cannot read the server's key or log in to its database (#501). Run: nix build .#checks.x86_64-linux.nixos
{ pkgs, module }:
pkgs.testers.runNixOSTest {
  name = "circagraph";

  nodes.machine = {
    imports = [ module ];
    virtualisation.memorySize = 2048;
    virtualisation.cores = 2;
    # Without KVM the machine is emulated, many times slower: PostgreSQL's first initdb and
    # the first migration then outlast systemd's usual 90 seconds.
    systemd.services.postgresql.serviceConfig.TimeoutStartSec = "20min";
    systemd.services.circagraph.serviceConfig.TimeoutStartSec = "20min";
    # As many servers set it: the module's virtual host keeps its own proxy headers regardless.
    services.nginx.recommendedProxySettings = true;
    services.circagraph = {
      enable = true;
      # A new installation's names, whatever the test machine's stateVersion.
      legacyNames = false;
      origin = "http://localhost";
      nginx.enable = true;
      # A test's secrets may be in the store; a real server's belong outside it.
      environmentFile = pkgs.writeText "circagraph-test.env" ''
        ADMIN_USERNAME=nixadmin
        ADMIN_INITIAL_PASSWORD=a long test password for nixos
      '';
      syslog = {
        enable = true;
        settings.SYSLOG_ROUTES_JSON = ''{"default":"00000000-0000-0000-0000-000000000000"}'';
        environmentFile = pkgs.writeText "circagraph-syslog-test.env" ''
          OCH_API_KEY=och_key_00000000000000000000000000000000_0000000000000000000000000000000000000000000000000000000000000000
        '';
      };
    };
  };

  testScript = ''
    machine.wait_for_unit("circagraph.service")
    # Its name before the rename starts and stops it too.
    machine.succeed("systemctl is-active openchronology.service")
    machine.wait_until_succeeds("curl -fs http://127.0.0.1:5173/healthz", timeout=1800)
    machine.wait_for_unit("nginx.service")
    machine.succeed("curl -fs http://localhost/healthz | grep -q '\"status\":\"ok\"'")
    machine.succeed("curl -fs http://localhost/ | grep -q 'Explore timelines'")
    # nginx names itself without its version (#521).
    machine.succeed(
        r"curl -fs -o /dev/null -D - http://localhost/healthz | tr -d '\r' | grep -qix 'server: nginx'"
    )
    machine.succeed(
        "runuser -u postgres -- psql -d circagraph -tAc "
        "\"SELECT extname FROM pg_extension WHERE extname='pgmp'\" | grep -qx pgmp"
    )
    key = machine.succeed("cat /var/lib/circagraph/generated.env")
    machine.succeed(
        "${pkgs.nodejs_24}/bin/node ${./test-client.mjs} http://localhost nixadmin "
        "'a long test password for nixos' >&2"
    )
    # Restarted (the setup and its migration again), the server keeps its key.
    machine.systemctl("restart circagraph-setup.service circagraph.service")
    machine.wait_until_succeeds("curl -fs http://127.0.0.1:5173/healthz", timeout=1800)
    assert key == machine.succeed("cat /var/lib/circagraph/generated.env"), "the key changed"
    # The syslog receiver, as circagraph-logs: listening, without the server's key or database.
    machine.wait_until_succeeds(
        "journalctl -u circagraph-syslog.service | grep -q 'syslog: listening'", timeout=600
    )
    machine.succeed(
        "test \"$(stat -c %U /proc/$(systemctl show -P MainPID circagraph-syslog.service))\" "
        "= circagraph-logs"
    )
    machine.fail("runuser -u circagraph-logs -- cat /var/lib/circagraph/generated.env")
    machine.fail(
        "runuser -u circagraph-logs -- ${pkgs.postgresql}/bin/psql -h /run/postgresql "
        "-d circagraph -Atc 'SELECT 1'"
    )
  '';
}

# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# services.circagraph (#461; docs/nix.md), formerly services.openchronology (still accepted, with
# a warning): the Circagraph server on NixOS, doing what
# the Debian package's scripts do (deploy/debian-server): system users (the log importers their
# own, #501), a local PostgreSQL database with pgmp, a generated AUTH_ENCRYPTION_KEY, the migration before each start, the
# server as a hardened systemd service, and optionally the mail worker, the log importers and
# an nginx virtual host in front of it.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.circagraph;
  inherit (lib)
    mkEnableOption
    mkIf
    mkMerge
    mkOption
    mkPackageOption
    types
    ;
  # The system users, database, role and state folders: circagraph, or openchronology for an
  # installation from before the rename to Circagraph, which keeps them (legacyNames).
  name = if cfg.legacyNames then "openchronology" else "circagraph";
  logs = "${name}-logs";
  state = "/var/lib/${name}";
  # The settings as the server reads them: strings, with booleans as 1 and 0.
  environment = lib.mapAttrs (
    _: value: if lib.isBool value then (if value then "1" else "0") else toString value
  ) cfg.settings;
  # The systemd hardening of the Debian units.
  hardening = {
    NoNewPrivileges = true;
    CapabilityBoundingSet = "";
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    RestrictSUIDSGID = true;
    RestrictNamespaces = true;
    # AF_NETLINK is for Node's network interface list.
    RestrictAddressFamilies = [
      "AF_UNIX"
      "AF_INET"
      "AF_INET6"
      "AF_NETLINK"
    ];
    LockPersonality = true;
    SystemCallArchitectures = "native";
    SystemCallFilter = [ "@system-service" ];
    SystemCallErrorNumber = "EPERM";
    UMask = "0077";
  };
  # A service running one of the package's commands as the server's user, with the
  # settings, the generated key and the administrator's environment file (which wins).
  service =
    {
      description,
      command,
      alias,
      extra ? { },
    }:
    {
      inherit description;
      # Its name before the rename to Circagraph starts and stops it too.
      aliases = [ "${alias}.service" ];
      after = [
        "network.target"
        "circagraph-setup.service"
      ]
      ++ lib.optional cfg.database.createLocally "postgresql.service"
      ++ lib.optional (command != "circagraph-server") "circagraph.service";
      requires = [ "circagraph-setup.service" ];
      # The workers after the server, which migrates the database as it starts.
      wants = lib.optional (command != "circagraph-server") "circagraph.service";
      wantedBy = [ "multi-user.target" ];
      inherit environment;
      serviceConfig = hardening // {
        Type = "simple";
        User = name;
        Group = name;
        EnvironmentFile = [ "${state}/generated.env" ] ++ lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        ExecStart = "${cfg.package}/bin/${command}";
        Restart = "on-failure";
        RestartSec = 5;
        # Node exits with 128 + SIGTERM when stopped; that is a clean stop, not a failure.
        SuccessExitStatus = 143;
        WorkingDirectory = "${cfg.package}/lib/circagraph";
      } // extra;
    };
  # A log importer (#501): as the log receivers' user, with only its own settings and
  # environment file, not the server's settings, generated key or environment file. It cannot
  # log in to the local database, which has no role for it.
  logService =
    {
      description,
      command,
      alias,
      settings,
      environmentFile,
      extra ? { },
    }:
    {
      inherit description;
      aliases = [ "${alias}.service" ];
      after = [
        "network.target"
        "circagraph.service"
      ];
      wants = [ "circagraph.service" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        OCH_API_URL = "http://${cfg.host}:${toString cfg.port}";
      }
      // settings;
      serviceConfig = hardening // {
        Type = "simple";
        User = logs;
        Group = logs;
        EnvironmentFile = lib.optional (environmentFile != null) environmentFile;
        ExecStart = "${cfg.package}/bin/${command}";
        Restart = "on-failure";
        RestartSec = 10;
        # Node exits with 128 + SIGTERM when stopped; that is a clean stop, not a failure.
        SuccessExitStatus = 143;
        WorkingDirectory = "${cfg.package}/lib/circagraph";
        # Other users' processes are hidden from it.
        ProtectProc = "invisible";
      } // extra;
    };
  # A log importer's own environment file.
  logEnvironmentFile =
    name:
    mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/openchronology-${name}.env";
      description = ''
        A file of KEY=value lines with the ${name} importer's secrets, such as OCH_API_KEY,
        overriding its `settings`. Only it reads this file, and it does not read the server's
        `environmentFile`. Files its settings name (routes, keys) must be readable by the
        log receivers' user (circagraph-logs, or openchronology-logs with `legacyNames`).
      '';
    };
in
{
  # The project became Circagraph: configurations written for services.openchronology keep
  # working, with a warning to rename them.
  imports = [
    (lib.mkRenamedOptionModule [ "services" "openchronology" ] [ "services" "circagraph" ])
  ];
  options.services.circagraph = {
    enable = mkEnableOption "Circagraph, the exact timeline platform";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.circagraph-server;
      defaultText = lib.literalExpression "circagraph.packages.\${system}.circagraph-server";
      description = "The Circagraph server package.";
    };

    legacyNames = mkOption {
      type = types.bool;
      default = lib.versionOlder config.system.stateVersion "26.11";
      defaultText = lib.literalExpression ''lib.versionOlder config.system.stateVersion "26.11"'';
      description = ''
        Keep the names an installation had before the project was renamed Circagraph: the
        system users openchronology and openchronology-logs, the PostgreSQL database and role
        openchronology, and the state folders /var/lib/openchronology,
        /var/lib/openchronology-github and /var/lib/openchronology-journald. Systems whose
        stateVersion is older than 26.11 keep them by default; new ones use circagraph. Only
        set it to false on a system that never ran the server, or after moving the database,
        users and folders yourself.
      '';
    };

    origin = mkOption {
      type = types.str;
      example = "https://timelines.example.org";
      description = ''
        The public origin, exactly as people reach it, without a trailing slash (APP_ORIGIN).
        The server refuses an http:// origin other than localhost unless
        `settings.ALLOW_INSECURE_ORIGIN` is set.
      '';
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "The address the server listens on (HOST). Keep it on loopback behind nginx.";
    };

    port = mkOption {
      type = types.port;
      default = 5173;
      description = "The port the server listens on (PORT).";
    };

    settings = mkOption {
      type = types.attrsOf (
        types.oneOf [
          types.str
          types.int
          types.bool
        ]
      );
      default = { };
      example = {
        PLATFORM_NAME = "Our timelines";
        TIMELINE_LINK_LIMIT = 5000;
        LANDING_PAGE = true;
      };
      description = ''
        Further configuration, as environment variables: any setting in
        deploy/debian-server/circagraph.env. Booleans become 1 and 0. Keep secrets
        (RESEND_API_KEY, ADMIN_INITIAL_PASSWORD, OAuth secrets) in `environmentFile`
        instead: these are written to the world-readable Nix store.
      '';
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/circagraph.env";
      description = ''
        A file of KEY=value lines with secrets, read by every Circagraph service and
        overriding `settings`. AUTH_ENCRYPTION_KEY may be given here; otherwise one is generated
        on first start in ${state}/generated.env (back it up apart from the database).
      '';
    };

    database = {
      createLocally = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Run PostgreSQL on this machine with the pgmp extension, and create the database and
          its role (both named circagraph, or openchronology with `legacyNames`), reached by
          peer authentication over the Unix socket. Otherwise set DATABASE_URL in `settings` or `environmentFile`, to a database
          where a superuser has run CREATE EXTENSION pgmp.
        '';
      };
    };

    mail.enable = mkEnableOption ''
      the account email worker, which sends sign-up, sign-in and other account mail through
      Resend (RESEND_API_KEY and AUTH_EMAIL_FROM)
    '';

    syslog = {
      enable = mkEnableOption "the syslog receiver, which records syslog messages as timelines";
      environmentFile = logEnvironmentFile "syslog";
      settings = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = {
          SYSLOG_HOST = "0.0.0.0";
          SYSLOG_PORT = "5514";
          SYSLOG_ROUTES = "/etc/circagraph/syslog-routes.json";
        };
        description = ''
          Its configuration (deploy/debian-server/syslog.env). OCH_API_URL defaults to this
          server; give its OCH_API_KEY in its own `environmentFile`.
        '';
      };
    };

    github = {
      enable = mkEnableOption "the GitHub receiver, which records issues and pull requests as timelines";
      environmentFile = logEnvironmentFile "github";
      settings = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = {
          GITHUB_PORT = "5580";
          GITHUB_ROUTES = "/etc/circagraph/github-routes.json";
        };
        description = ''
          Its configuration (deploy/debian-server/github.env). OCH_API_URL defaults to this
          server and GITHUB_STATE to a file in its state directory; give its OCH_API_KEY and
          GITHUB_WEBHOOK_SECRET (and GITHUB_TOKEN) in its own `environmentFile`.
        '';
      };
    };

    journald = {
      enable = mkEnableOption "the journald follower, which records the systemd journal as timelines";
      environmentFile = logEnvironmentFile "journald";
      settings = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = {
          JOURNALD_TIMELINE = "00000000-0000-0000-0000-000000000000";
          JOURNALD_UNITS = "nginx.service";
        };
        description = ''
          Its configuration (deploy/debian-server/journald.env). OCH_API_URL defaults to this
          server; give its OCH_API_KEY in its own `environmentFile`.
        '';
      };
    };

    nginx = {
      enable = mkEnableOption "an nginx virtual host in front of the server";
      hostName = mkOption {
        type = types.str;
        default = lib.head (lib.splitString ":" (lib.removePrefix "https://" (lib.removePrefix "http://" cfg.origin)));
        defaultText = lib.literalExpression "the host of `origin`";
        description = ''
          The virtual host's name. Set `services.nginx.virtualHosts.<name>.enableACME` and
          `forceSSL` for HTTPS.
        '';
      };
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      services.circagraph.settings = {
        APP_ORIGIN = lib.mkDefault cfg.origin;
        HOST = lib.mkDefault cfg.host;
        PORT = lib.mkDefault cfg.port;
        # Downloads are cached in the service's cache directory (EXPORT_CACHE).
        EXPORT_CACHE_DIR = lib.mkDefault "/var/cache/${name}";
      };

      users.users.${name} = {
        isSystemUser = true;
        group = name;
        home = state;
        description = "Circagraph server";
      };
      users.groups.${name} = { };

      environment.systemPackages = [ cfg.package ];

      # Before the services: the encryption key, generated once, and pgmp in the database, which
      # only a superuser may create. The server migrates the database each time it starts.
      systemd.services.circagraph-setup = {
        description = "Circagraph setup: its key and pgmp";
        aliases = [ "openchronology-setup.service" ];
        after = [ "network.target" ] ++ lib.optionals cfg.database.createLocally [
          "postgresql.service"
          "postgresql-setup.service"
        ];
        requires = lib.optional cfg.database.createLocally "postgresql.service";
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          StateDirectory = name;
          StateDirectoryMode = "0750";
        };
        path = [
          pkgs.util-linux
          pkgs.coreutils
        ];
        script = ''
          set -eu
          if [ ! -s ${state}/generated.env ]; then
            umask 0077
            echo "AUTH_ENCRYPTION_KEY=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" > ${state}/generated.env.new
            mv ${state}/generated.env.new ${state}/generated.env
          fi
          chown root:${name} ${state}/generated.env
          chmod 0640 ${state}/generated.env
          ${lib.optionalString cfg.database.createLocally ''
            runuser -u postgres -- ${config.services.postgresql.package}/bin/psql -X -q \
              -v ON_ERROR_STOP=1 -d ${name} -c 'CREATE EXTENSION IF NOT EXISTS pgmp'
          ''}
        '';
      };

      systemd.services.circagraph = service {
        description = "Circagraph platform";
        command = "circagraph-server";
        alias = "openchronology";
        extra = {
          # The database brought up to this version's schema first (circagraph-migrate).
          ExecStartPre = "${cfg.package}/bin/circagraph-migrate";
          # Open live views keep the server from exiting promptly; do not wait long for them.
          TimeoutStopSec = 10;
          CacheDirectory = name;
        };
      };
    }

    (mkIf cfg.database.createLocally {
      services.postgresql = {
        enable = true;
        extensions = ps: [ (ps.callPackage ./pgmp.nix { }) ];
        ensureDatabases = [ name ];
        ensureUsers = [
          {
            inherit name;
            ensureDBOwnership = true;
          }
        ];
      };
      services.circagraph.settings.DATABASE_URL = lib.mkDefault "postgresql:///${name}?host=/run/postgresql";
    })

    (mkIf cfg.mail.enable {
      systemd.services.circagraph-mail = service {
        description = "Circagraph account email delivery (Resend)";
        command = "circagraph-mail";
        alias = "openchronology-mail";
      };
    })

    (mkIf (cfg.syslog.enable || cfg.github.enable || cfg.journald.enable) {
      # The log importers' own user (#501).
      users.users.${logs} = {
        isSystemUser = true;
        group = logs;
        description = "Circagraph log receivers";
      };
      users.groups.${logs} = { };
    })

    (mkIf cfg.syslog.enable {
      warnings = lib.optional (cfg.syslog.environmentFile == null) ''
        services.circagraph.syslog.environmentFile is not set: the syslog receiver does not
        read services.circagraph.environmentFile (#501), so give its OCH_API_KEY there.
      '';
      systemd.services.circagraph-syslog = logService {
        description = "Circagraph syslog receiver";
        command = "circagraph-syslog";
        alias = "openchronology-syslog";
        inherit (cfg.syslog) settings environmentFile;
      };
    })

    (mkIf cfg.github.enable {
      warnings = lib.optional (cfg.github.environmentFile == null) ''
        services.circagraph.github.environmentFile is not set: the GitHub receiver does not
        read services.circagraph.environmentFile (#501), so give its OCH_API_KEY and
        GITHUB_WEBHOOK_SECRET there.
      '';
      systemd.services.circagraph-github = logService {
        description = "Circagraph GitHub receiver";
        command = "circagraph-github";
        alias = "openchronology-github";
        settings = {
          GITHUB_STATE = "/var/lib/${name}-github/github-state.json";
        }
        // cfg.github.settings;
        inherit (cfg.github) environmentFile;
        extra = {
          # Each item's board column, kept across restarts (GITHUB_STATE).
          StateDirectory = "${name}-github";
        };
      };
    })

    (mkIf cfg.journald.enable {
      warnings = lib.optional (cfg.journald.environmentFile == null) ''
        services.circagraph.journald.environmentFile is not set: the journald follower does
        not read services.circagraph.environmentFile (#501), so give its OCH_API_KEY there.
      '';
      systemd.services.circagraph-journald = logService {
        description = "Circagraph journald follower";
        command = "circagraph-journald";
        alias = "openchronology-journald";
        inherit (cfg.journald) settings environmentFile;
        extra = {
          # Reading the journal needs systemd-journal, which the syslog receiver (also
          # the log receivers' user) does not have. As the main group, it also keeps the receiver
          # from tracing this process or reading its memory (that needs the same groups).
          Group = "systemd-journal";
          SupplementaryGroups = [ logs ];
          # The cursor of the last entry sent (and, over SSH, the hosts seen).
          StateDirectory = "${name}-journald";
        };
      };
    })

    (mkIf cfg.nginx.enable {
      # nginx replaces X-Forwarded-For with the client's address, so the server may trust it.
      services.circagraph.settings.TRUST_PROXY = lib.mkDefault true;
      services.nginx = {
        enable = true;
        # No nginx version in the Server header and error pages (#521); NixOS's default too.
        serverTokens = lib.mkDefault false;
        virtualHosts.${cfg.nginx.hostName}.locations."/" = {
          proxyPass = "http://${cfg.host}:${toString cfg.port}";
          proxyWebsockets = true;
          # Only this location's headers: services.nginx.recommendedProxySettings would add a
          # second X-Forwarded-For (the client's list), and the server, which takes the header
          # only as a single address, would then count every client as nginx itself.
          recommendedProxySettings = false;
          extraConfig = ''
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;
            client_max_body_size 256m;
            proxy_buffering off;
            proxy_read_timeout 1h;
          '';
        };
      };
    })
  ]);
}

# typed: false
# frozen_string_literal: true

# Homebrew formula for cc-bridge
# This formula installs the cc-bridge service configuration

class CcBridge < Formula
  desc "Telegram webhook server for Claude Code"
  homepage "https://github.com/yourusername/cc-bridge"
  version "0.1.0"

  # Empty bottle - we don't need to compile anything
  bottle :unneeded

  # Install the plist file for launchd
  def install
    # Copy the plist file to Homebrew's location
    (prefix/"homebrew.mxcl.cc-bridge.plist").write plist_content
  end

  # Generate the plist content dynamically
  def plist_content
    <<~EOS
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
          <!-- Service identifier (using brew naming convention) -->
          <key>Label</key>
          <string>homebrew.mxcl.cc-bridge</string>

          <!-- Command to run: cc-bridge server -->
          <key>ProgramArguments</key>
          <array>
              <string>#{HOMEBREW_PREFIX}/bin/cc-bridge</string>
              <string>server</string>
              <string>--host</string>
              <string>0.0.0.0</string>
              <string>--port</string>
              <string>8080</string>
          </array>

          <!-- Start service immediately after load -->
          <key>RunAtLoad</key>
          <true/>

          <!-- Restart service if it crashes -->
          <key>KeepAlive</key>
          <dict>
              <!-- Restart if it exits with an error -->
              <key>SuccessfulExit</key>
              <false/>
              <!-- Restart if it crashes -->
              <key>Crashed</key>
              <true/>
          </dict>

          <!-- Environment variables -->
          <key>EnvironmentVariables</key>
          <dict>
              <!-- Ensure PATH includes virtual environment -->
              <key>PATH</key>
              <string>#{HOMEBREW_PREFIX}/bin:#{HOMEBREW_PREFIX}/sbin:/usr/local/bin:/usr/bin:/bin</string>
          </dict>

          <!-- Working directory -->
          <key>WorkingDirectory</key>
          <string>#{ENV["HOME"]}/xprojects/cc-bridge</string>

          <!-- Standard output log file -->
          <key>StandardOutPath</key>
          <string>#{HOMEBREW_PREFIX}/var/log/cc-bridge/server.log</string>

          <!-- Standard error log file -->
          <key>StandardErrorPath</key>
          <string>#{HOMEBREW_PREFIX}/var/log/cc-bridge/server.error.log</string>

          <!-- Resource limits -->
          <key>SoftResourceLimits</key>
          <dict>
              <!-- Max number of open file descriptors -->
              <key>NumberOfFiles</key>
              <integer>1024</integer>
          </dict>

          <!-- Process type (adaptive for Apple Silicon) -->
          <key>ProcessType</key>
          <string>Adaptive</string>

          <!-- Nice value (process priority, 0 is normal) -->
          <key>Nice</key>
          <integer>0</integer>
      </dict>
      </plist>
    EOS
  end

  # Create log directory on installation
  def post_install
    (var/"log/cc-bridge").mkpath
  end

  test do
    # Simple test to verify the formula is installed
    system "true"
  end
end

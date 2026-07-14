const fs = require('fs');
const path = require('path');
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
} = require('expo/config-plugins');

const FALLBACK_MARKER = 'AlVolant fallback when a resigning tool strips the App Group';
const FALLBACK_VERSION_MARKER = 'AlVolant local arrival time fallback v3';
const SECTION_START = '@available(iOS 16.1, *)\nprivate struct LiveActivitySectionView: View {';
const SECTION_END = '\nextension WidgetConfiguration {';

const LIVE_ACTIVITY_FALLBACK = `// ${FALLBACK_MARKER}
// ${FALLBACK_VERSION_MARKER}
private struct AlVolantFallbackProps {
  let line: String
  let direction: String
  let nextStop: String
  let nextStopLabel: String
  let etaLabel: String
  let etaValue: String
  let etaEpochMs: Double

  init(json: String) {
    let dictionary: [String: Any]
    if let data = json.data(using: .utf8),
       let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      dictionary = value
    } else {
      dictionary = [:]
    }

    func text(_ key: String, fallback: String, limit: Int) -> String {
      guard let raw = dictionary[key] as? String else { return fallback }
      let normalized = raw
        .replacingOccurrences(of: "\\n", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      return String((normalized.isEmpty ? fallback : normalized).prefix(limit))
    }

    line = text("line", fallback: "Bus", limit: 16)
    direction = text("direction", fallback: "En ruta", limit: 96)
    nextStop = text("nextStop", fallback: "--", limit: 120)
    nextStopLabel = text("nextStopLabel", fallback: "Propera parada", limit: 32)
    etaLabel = text("etaLabel", fallback: "Arribada", limit: 24)
    etaValue = text("etaValue", fallback: "--", limit: 12)
    etaEpochMs = dictionary["etaEpochMs"] as? Double ?? 0
  }
}

@available(iOS 16.1, *)
private struct AlVolantFallbackEta: View {
  let props: AlVolantFallbackProps
  let size: CGFloat

  var body: some View {
    if props.etaEpochMs > 0 {
      Text(Date(timeIntervalSince1970: props.etaEpochMs / 1_000), style: .time)
      .font(.system(size: size, weight: .semibold, design: .rounded))
      .monospacedDigit()
      .foregroundStyle(.white)
    } else {
      Text(props.etaValue)
        .font(.system(size: size, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
    }
  }
}

@available(iOS 16.1, *)
private struct LiveActivitySectionView: View {
  let context: ActivityViewContext<LiveActivityAttributes>
  let nodes: [String: Any]
  let sectionName: String

  private var props: AlVolantFallbackProps {
    AlVolantFallbackProps(json: context.state.props)
  }

  @ViewBuilder
  private var fallback: some View {
    switch sectionName {
    case "compactLeading":
      HStack(spacing: 4) {
        Image(systemName: "bus.fill")
          .font(.system(size: 12))
          .foregroundStyle(Color(red: 0.45, green: 0.82, blue: 0.73))
        Text(props.line)
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(.white)
          .lineLimit(1)
      }
      .padding(.leading, 3)
    case "compactTrailing":
      AlVolantFallbackEta(props: props, size: 12)
        .frame(width: 46, alignment: .trailing)
    case "minimal":
      Image(systemName: "bus.fill")
        .font(.system(size: 14))
        .foregroundStyle(Color(red: 0.45, green: 0.82, blue: 0.73))
    case "expandedLeading":
      HStack(spacing: 5) {
        Image(systemName: "bus.fill")
          .foregroundStyle(Color(red: 0.45, green: 0.82, blue: 0.73))
        Text(props.line)
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(.white)
          .lineLimit(1)
      }
      .padding(.leading, 8)
    case "expandedTrailing":
      VStack(alignment: .trailing, spacing: 1) {
        Text(props.etaLabel)
          .font(.system(size: 9))
          .foregroundStyle(Color(red: 0.78, green: 0.84, blue: 0.82))
        AlVolantFallbackEta(props: props, size: 14)
      }
      .padding(.trailing, 8)
    case "expandedCenter":
      Text(props.direction)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .lineLimit(1)
        .padding(.horizontal, 8)
    case "expandedBottom":
      HStack(spacing: 8) {
        Image(systemName: "mappin.and.ellipse")
          .foregroundStyle(Color(red: 0.45, green: 0.82, blue: 0.73))
        VStack(alignment: .leading, spacing: 1) {
          Text(props.nextStopLabel)
            .font(.system(size: 10))
            .foregroundStyle(Color(red: 0.78, green: 0.84, blue: 0.82))
          Text(props.nextStop)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 12)
      .padding(.bottom, 8)
    default:
      EmptyView()
    }
  }

  var body: some View {
    if let node = nodes[sectionName] as? [String: Any] {
      WidgetsDynamicView(name: context.activityID, kind: .liveActivity, node: node)
    } else {
      fallback
    }
  }
}

@available(iOS 16.1, *)
private struct AlVolantFallbackBanner: View {
  let props: AlVolantFallbackProps

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Text(props.line)
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(.white)
          .padding(.horizontal, 10)
          .frame(height: 30)
          .background(Color(red: 0.09, green: 0.42, blue: 0.35))
          .clipShape(RoundedRectangle(cornerRadius: 7))
        Text(props.direction)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(Color(red: 0.13, green: 0.15, blue: 0.13))
          .lineLimit(1)
        Spacer()
        VStack(alignment: .trailing, spacing: 1) {
          Text(props.etaLabel)
            .font(.system(size: 10))
            .foregroundStyle(Color(red: 0.44, green: 0.46, blue: 0.43))
          AlVolantFallbackEta(props: props, size: 15)
            .colorInvert()
        }
      }
      HStack(spacing: 7) {
        Image(systemName: "bus.fill")
          .foregroundStyle(Color(red: 0.09, green: 0.42, blue: 0.35))
        Text(props.nextStop)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Color(red: 0.13, green: 0.15, blue: 0.13))
          .lineLimit(1)
      }
    }
    .padding(16)
    .activityBackgroundTint(Color(red: 0.95, green: 0.94, blue: 0.91))
  }
}

@available(iOS 16.1, *)
private struct LiveActivityBannerView: View {
  var context: ActivityViewContext<LiveActivityAttributes>
  let nodes: [String: Any]

  var body: some View {
    if nodes["banner"] == nil && nodes["bannerSmall"] == nil {
      AlVolantFallbackBanner(props: AlVolantFallbackProps(json: context.state.props))
    } else if #available(iOS 18.0, *) {
      LiveActivityBanner(context: context, nodes: nodes)
    } else if let node = nodes["banner"] as? [String: Any] {
      WidgetsDynamicView(name: context.activityID, kind: .liveActivity, node: node)
    } else {
      AlVolantFallbackBanner(props: AlVolantFallbackProps(json: context.state.props))
    }
  }
}
`;

function withLiveActivityResigningFallback(config) {
  return withDangerousMod(config, ['ios', async (mod) => {
    const sourcePath = path.join(
      mod.modRequest.projectRoot,
      'node_modules',
      'expo-widgets',
      'ios',
      'Widgets',
      'WidgetLiveActivity.swift',
    );
    const source = fs.readFileSync(sourcePath, 'utf8');
    if (source.includes(FALLBACK_VERSION_MARKER)) return mod;

    const existingFallbackStart = source.indexOf(`// ${FALLBACK_MARKER}`);
    const start = existingFallbackStart >= 0
      ? existingFallbackStart
      : source.indexOf(SECTION_START);
    const end = source.indexOf(SECTION_END, start);
    if (start < 0 || end < 0) {
      throw new Error('expo-widgets has changed; review the AlVolant Live Activity fallback patch.');
    }

    fs.writeFileSync(
      sourcePath,
      `${source.slice(0, start)}${LIVE_ACTIVITY_FALLBACK}${source.slice(end)}`,
      'utf8',
    );
    return mod;
  }]);
}

/**
 * expo-widgets 57.0.3 currently writes `aps-environment` even when remote
 * Live Activity updates are disabled. AlVolant only performs local ActivityKit
 * updates, so keep the generated native project free of the APNs capability.
 */
module.exports = function withLocalLiveActivities(config) {
  config = withLiveActivityResigningFallback(config);
  config = withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });

  return withInfoPlist(config, (mod) => {
    mod.modResults.ExpoWidgets_EnablePushNotifications = false;
    mod.modResults.NSSupportsLiveActivitiesFrequentUpdates = false;
    // This is a user-initiated route session. Keep only When In Use permission:
    // the native location background mode and its visible indicator are enough
    // to continue that active session when the phone locks or changes app.
    delete mod.modResults.NSLocationAlwaysAndWhenInUseUsageDescription;
    delete mod.modResults.NSLocationAlwaysUsageDescription;
    // TaskManager adds `fetch` globally, but this app only uses the dedicated
    // Core Location background mode. Do not advertise an unused capability.
    if (Array.isArray(mod.modResults.UIBackgroundModes)) {
      mod.modResults.UIBackgroundModes = mod.modResults.UIBackgroundModes
        .filter((mode) => mode !== 'fetch' && mode !== 'remote-notification');
    }
    return mod;
  });
};

import {
  HStack,
  Image,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui';
import {
  activityBackgroundTint,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';

export type RouteLiveActivityProps = {
  line: string;
  direction: string;
  nextStop: string;
  nextStopLabel: string;
  etaLabel: string;
  etaValue: string;
  updatedAtEpochMs: number;
  etaEpochMs: number;
  routeColor: string;
  routeTextColor: string;
};

const RouteLiveActivity = (
  props: RouteLiveActivityProps,
  environment: LiveActivityEnvironment,
) => {
  'widget';

  // Everything used by the widget lives inside this function because the
  // `widget` directive serializes it into the extension's isolated runtime.
  const PALETTE = {
    background: '#F1EFE8',
    ink: '#202520',
    muted: '#70756D',
    primary: '#176B5A',
    white: '#FFFFFF',
  };
  const reducedLuminance = environment.isLuminanceReduced === true;
  const bannerAccent = reducedLuminance ? '#82B4A8' : PALETTE.primary;
  // Dynamic Island is always rendered over a black system surface. Keep a
  // dedicated, brighter accent here instead of reusing the map's dark green.
  const islandAccent = reducedLuminance ? '#D6EAE5' : '#72D2BB';
  const islandMuted = '#C8D6D1';
  const eta = new Date(props.etaEpochMs);
  const hasEta = Number.isFinite(props.etaEpochMs) && props.etaEpochMs > 0;

  const Eta = ({
    color,
    size,
    width,
  }: {
    color: string;
    size: number;
    width: number;
  }) => hasEta ? (
    <Text
      date={eta}
      dateStyle="time"
      modifiers={[
        font({ weight: 'semibold', size }),
        foregroundStyle(color),
        monospacedDigit(),
        multilineTextAlignment('trailing'),
        frame({ width, alignment: 'trailing' }),
      ]}
    />
  ) : (
    <Text
      modifiers={[
        font({ weight: 'semibold', size }),
        foregroundStyle(color),
        frame({ width, alignment: 'trailing' }),
      ]}
    >
      {props.etaValue}
    </Text>
  );

  const LineBadge = ({ compact = false }: { compact?: boolean }) => (
    <ZStack>
      <RoundedRectangle
        cornerRadius={compact ? 5 : 7}
        modifiers={[
          foregroundStyle(props.routeColor),
          frame({
            width: compact ? 34 : 48,
            height: compact ? 22 : 30,
          }),
        ]}
      />
      <Text
        modifiers={[
          font({ weight: 'bold', size: compact ? 11 : 14 }),
          foregroundStyle(props.routeTextColor),
          lineLimit(1),
        ]}
      >
        {props.line}
      </Text>
    </ZStack>
  );

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={11}
        modifiers={[
          activityBackgroundTint(PALETTE.background),
          padding({ all: 16 }),
        ]}
      >
        <HStack spacing={10}>
          <LineBadge />
          <VStack alignment="leading" spacing={2}>
            <Text
              modifiers={[
                font({ weight: 'semibold', size: 14 }),
                foregroundStyle(PALETTE.ink),
                lineLimit(1),
              ]}
            >
              {props.direction}
            </Text>
            <Text
              modifiers={[
                font({ size: 11 }),
                foregroundStyle(PALETTE.muted),
                lineLimit(1),
              ]}
            >
              {props.nextStopLabel}
            </Text>
          </VStack>
          <Spacer />
          <VStack alignment="trailing" spacing={2}>
            <Text modifiers={[font({ size: 10 }), foregroundStyle(PALETTE.muted)]}>
              {props.etaLabel}
            </Text>
            <Eta color={bannerAccent} size={17} width={62} />
          </VStack>
        </HStack>
        <HStack spacing={7}>
          <Image systemName="bus.fill" size={13} color={bannerAccent} />
          <Text
            modifiers={[
              font({ weight: 'medium', size: 14 }),
              foregroundStyle(PALETTE.ink),
              lineLimit(1),
            ]}
          >
            {props.nextStop}
          </Text>
        </HStack>
      </VStack>
    ),
    bannerSmall: (
      <HStack
        spacing={8}
        modifiers={[
          activityBackgroundTint(PALETTE.background),
          padding({ all: 12 }),
        ]}
      >
        <LineBadge compact />
        <Text
          modifiers={[
            font({ weight: 'semibold', size: 12 }),
            foregroundStyle(PALETTE.ink),
            lineLimit(1),
          ]}
        >
          {props.nextStop}
        </Text>
        <Spacer />
        <Eta color={PALETTE.primary} size={12} width={48} />
      </HStack>
    ),
    compactLeading: (
      <HStack spacing={4} modifiers={[padding({ leading: 3 })]}>
        <Image systemName="bus.fill" size={12} color={islandAccent} />
        <Text
          modifiers={[
            font({ weight: 'bold', size: 12 }),
            foregroundStyle(PALETTE.white),
            lineLimit(1),
          ]}
        >
          {props.line}
        </Text>
      </HStack>
    ),
    compactTrailing: (
      <Eta color={PALETTE.white} size={12} width={46} />
    ),
    minimal: <Image systemName="bus.fill" size={14} color={islandAccent} />,
    expandedLeading: (
      <HStack spacing={5} modifiers={[padding({ leading: 8, top: 2 })]}>
        <Image systemName="bus.fill" size={13} color={islandAccent} />
        <Text
          modifiers={[
            font({ weight: 'bold', size: 13 }),
            foregroundStyle(PALETTE.white),
            lineLimit(1),
          ]}
        >
          {props.line}
        </Text>
      </HStack>
    ),
    expandedTrailing: (
      <VStack
        alignment="trailing"
        spacing={1}
        modifiers={[padding({ trailing: 8, top: 2 })]}
      >
        <Text modifiers={[font({ size: 9 }), foregroundStyle(islandMuted)]}>
          {props.etaLabel}
        </Text>
        <Eta color={PALETTE.white} size={14} width={50} />
      </VStack>
    ),
    expandedCenter: (
      <Text
        modifiers={[
          font({ weight: 'semibold', size: 13 }),
          foregroundStyle(PALETTE.white),
          lineLimit(1),
          multilineTextAlignment('center'),
          padding({ top: 3, horizontal: 8 }),
        ]}
      >
        {props.direction}
      </Text>
    ),
    expandedBottom: (
      <HStack
        spacing={8}
        modifiers={[padding({ top: 5, bottom: 8, horizontal: 12 })]}
      >
        <Image systemName="mappin.and.ellipse" size={14} color={islandAccent} />
        <VStack alignment="leading" spacing={1}>
          <Text modifiers={[font({ size: 10 }), foregroundStyle(islandMuted)]}>
            {props.nextStopLabel}
          </Text>
          <Text
            modifiers={[
              font({ weight: 'semibold', size: 13 }),
              foregroundStyle(PALETTE.white),
              lineLimit(1),
            ]}
          >
            {props.nextStop}
          </Text>
        </VStack>
      </HStack>
    ),
  };
};

export default createLiveActivity<RouteLiveActivityProps>(
  'RouteLiveActivity',
  RouteLiveActivity,
);

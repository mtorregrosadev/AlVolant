import React, { Component, type ErrorInfo, type PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, spacing } from '../theme';
import { telemetry } from '../services/telemetry';

type State = { failed: boolean };

export default class AppErrorBoundary extends Component<PropsWithChildren, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    telemetry.captureException(
      error,
      { phase: 'render', is_fatal: false },
      'render_error',
    );
    if (__DEV__) console.error('React render error', error, info.componentStack);
  }

  private retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.title}>No s’ha pogut mostrar aquesta pantalla.</Text>
        <Text style={styles.body}>L’error s’ha registrat sense dades personals.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={this.retry}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>Torna-ho a provar</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xxl,
    backgroundColor: colors.background,
  },
  title: {
    maxWidth: 360,
    color: colors.ink,
    fontFamily: fonts.strong,
    fontSize: 20,
    textAlign: 'center',
  },
  body: {
    maxWidth: 360,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 14,
    textAlign: 'center',
  },
  button: {
    minHeight: 46,
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: 14,
    backgroundColor: colors.primary,
  },
  buttonPressed: { opacity: 0.82 },
  buttonText: {
    color: colors.white,
    fontFamily: fonts.strong,
    fontSize: 14,
  },
});

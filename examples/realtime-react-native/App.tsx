import { StatusBar } from 'expo-status-bar';
import * as Device from 'expo-device';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  RealtimeAgent,
  RealtimeSession,
  type RealtimeItem,
} from '@openai/agents-realtime';
import { ReactNativeWebRTCTransport } from './src/ReactNativeWebRTCTransport';

const MODEL = 'gpt-realtime-2.1';
const DEFAULT_TOKEN_URL = Platform.select({
  android: 'http://10.0.2.2:8787/token',
  default: 'http://127.0.0.1:8787/token',
});
const TOKEN_URL =
  process.env.EXPO_PUBLIC_REALTIME_TOKEN_URL ?? DEFAULT_TOKEN_URL;
const E2E_MODE = process.env.EXPO_PUBLIC_REACT_NATIVE_E2E === '1';
const IS_IOS_SIMULATOR = Platform.OS === 'ios' && !Device.isDevice;

const agent = new RealtimeAgent({
  name: 'React Native assistant',
  instructions:
    'Be concise and helpful. Reply in the language used by the user.',
});

export default function App() {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const eventLogRef = useRef<ScrollView | null>(null);
  const connectingRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const [status, setStatus] = useState('disconnected');
  const [history, setHistory] = useState<RealtimeItem[]>([]);
  const [message, setMessage] = useState('Hello from React Native.');
  const [lastError, setLastError] = useState<string | null>(null);

  const disconnect = useCallback(() => {
    const session = sessionRef.current;
    connectionGenerationRef.current += 1;
    sessionRef.current = null;
    connectingRef.current = false;
    setStatus('disconnected');
    try {
      session?.close();
    } catch (error) {
      setLastError(toErrorMessage(error));
    }
  }, []);

  const connect = useCallback(async () => {
    if (sessionRef.current || connectingRef.current) {
      return;
    }

    connectingRef.current = true;
    const generation = ++connectionGenerationRef.current;
    let session: RealtimeSession | null = null;
    let wasConnected = false;
    setLastError(null);
    try {
      await requestMicrophonePermission();
      if (connectionGenerationRef.current !== generation) {
        return;
      }
      const transport = new ReactNativeWebRTCTransport({
        model: MODEL,
        enableAudio: !IS_IOS_SIMULATOR,
      });
      const getEphemeralKey = async () => {
        const response = await fetch(TOKEN_URL, { method: 'POST' });
        if (!response.ok) {
          throw new Error(
            `Token server returned ${response.status}: ${await response.text()}`,
          );
        }
        const result = (await response.json()) as { value?: string };
        if (!result.value) {
          throw new Error(
            'Token server response did not contain a client key.',
          );
        }
        return result.value;
      };

      const connectedSession = new RealtimeSession(agent, {
        apiKey: getEphemeralKey,
        config: IS_IOS_SIMULATOR ? { outputModalities: ['text'] } : undefined,
        model: MODEL,
        transport,
      });
      session = connectedSession;
      sessionRef.current = connectedSession;
      transport.on('connection_change', (nextStatus) => {
        if (
          connectionGenerationRef.current === generation &&
          sessionRef.current === connectedSession
        ) {
          if (nextStatus === 'connected') {
            wasConnected = true;
          } else if (nextStatus === 'disconnected' && wasConnected) {
            connectionGenerationRef.current += 1;
            try {
              connectedSession.close();
            } catch (error) {
              setLastError(toErrorMessage(error));
            }
            sessionRef.current = null;
            connectingRef.current = false;
          }
          setStatus(nextStatus);
        }
      });
      transport.on('turn_done', () => {
        if (
          E2E_MODE &&
          connectionGenerationRef.current === generation &&
          sessionRef.current === connectedSession
        ) {
          console.info('RN_REALTIME_E2E:PASS');
        }
      });
      connectedSession.on('history_updated', (nextHistory) => {
        if (
          connectionGenerationRef.current === generation &&
          sessionRef.current === connectedSession
        ) {
          setHistory(nextHistory);
        }
      });
      connectedSession.on('error', (error) => {
        if (
          connectionGenerationRef.current !== generation ||
          sessionRef.current !== connectedSession
        ) {
          return;
        }
        const text = toErrorMessage(error.error);
        setLastError(text);
        if (E2E_MODE) {
          console.error(`RN_REALTIME_E2E:FAIL:${text}`);
        }
      });

      await connectedSession.connect({ apiKey: getEphemeralKey });
      if (
        connectionGenerationRef.current !== generation ||
        sessionRef.current !== connectedSession
      ) {
        connectedSession.close();
        return;
      }
      if (E2E_MODE) {
        connectedSession.sendMessage('Reply with exactly READY.');
      }
    } catch (error) {
      if (connectionGenerationRef.current !== generation) {
        session?.close();
        return;
      }
      const text = toErrorMessage(error);
      setLastError(text);
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
      session?.close();
      setStatus('disconnected');
      if (E2E_MODE) {
        console.error(`RN_REALTIME_E2E:FAIL:${text}`);
      }
    } finally {
      if (connectionGenerationRef.current === generation) {
        connectingRef.current = false;
      }
    }
  }, []);

  useEffect(() => disconnect, [disconnect]);

  useEffect(() => {
    if (E2E_MODE) {
      void connect();
    }
  }, [connect]);

  const sendMessage = () => {
    const text = message.trim();
    if (!text || !sessionRef.current) {
      return;
    }
    sessionRef.current.sendMessage(text);
    setMessage('');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        <Text style={styles.title}>Agents Realtime React Native</Text>
        <Text style={styles.status}>Status: {status}</Text>
        <Text style={styles.hint}>Token server: {TOKEN_URL}</Text>
        {IS_IOS_SIMULATOR ? (
          <Text style={styles.hint}>
            Audio is temporarily disabled on iOS Simulator because of a current
            Simulator audio issue. Use a physical device to test voice.
          </Text>
        ) : null}

        <View style={styles.row}>
          <Button title="Connect" onPress={() => void connect()} />
          <Button title="Disconnect" onPress={disconnect} />
        </View>

        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={status === 'connected'}
          keyboardType={IS_IOS_SIMULATOR ? 'ascii-capable' : 'default'}
          multiline
          onChangeText={setMessage}
          placeholder="Type a message"
          spellCheck={false}
          style={styles.input}
          value={message}
        />
        <Button
          disabled={status !== 'connected' || message.trim().length === 0}
          title="Send text"
          onPress={sendMessage}
        />

        {lastError ? <Text style={styles.error}>{lastError}</Text> : null}

        <Text style={styles.sectionTitle}>Conversation events</Text>
        <ScrollView
          contentContainerStyle={styles.logContent}
          directionalLockEnabled
          nestedScrollEnabled
          onContentSizeChange={() =>
            eventLogRef.current?.scrollToEnd({ animated: true })
          }
          ref={eventLogRef}
          scrollEnabled
          showsVerticalScrollIndicator
          style={styles.logScroller}
        >
          <Text selectable style={styles.log}>
            {history.length > 0
              ? JSON.stringify(history.slice(-8), null, 2)
              : 'No events yet.'}
          </Text>
        </ScrollView>
      </ScrollView>
    </SafeAreaView>
  );
}

async function requestMicrophonePermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) {
    return;
  }

  const result = await PermissionsAndroid.request(permission, {
    title: 'Microphone permission',
    message: 'The Realtime example needs your microphone for a voice session.',
    buttonPositive: 'Continue',
  });
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('Microphone permission was not granted.');
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#f5f7fb', flex: 1 },
  container: { gap: 16, padding: 24 },
  title: { color: '#111827', fontSize: 26, fontWeight: '700' },
  status: { color: '#1f2937', fontSize: 16, fontWeight: '600' },
  hint: { color: '#6b7280', fontSize: 12 },
  row: { flexDirection: 'row', gap: 16 },
  input: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 80,
    padding: 12,
    textAlignVertical: 'top',
  },
  error: { color: '#b91c1c' },
  sectionTitle: { color: '#111827', fontSize: 18, fontWeight: '600' },
  logScroller: {
    backgroundColor: '#111827',
    borderRadius: 8,
    height: 320,
  },
  logContent: { padding: 12 },
  log: {
    color: '#d1fae5',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
  },
});

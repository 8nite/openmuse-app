import { Square, Volume2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, Text, type TextStyle, View } from "react-native";
import Markdown, { type MarkdownStyles, type RenderRules } from "react-native-markdown-renderer";
import { assistantMarkdown, isSafeAssistantUrl } from "./assistant-markdown";
import { isSpeechSupported, speakMarkdown, stopSpeaking } from "./speech";
import { colors, ErrorNotice } from "./ui";

const textStyle = { color: colors.text, fontSize: 16, lineHeight: 24 };
const style: Partial<MarkdownStyles> = {
  text: textStyle,
  paragraph: { marginTop: 0, marginBottom: 6 },
  list: { marginBottom: 6 },
  headingContainer: { marginTop: 8, marginBottom: 4 },
  heading1: { fontSize: 21, lineHeight: 27 },
  heading2: { fontSize: 19, lineHeight: 25 },
  heading3: { fontSize: 17, lineHeight: 23 },
  link: { color: colors.blueDark, textDecorationLine: "underline" },
  codeInline: { backgroundColor: "#E2E4E7", color: colors.text },
  codeBlock: { backgroundColor: "#E2E4E7", color: colors.text },
};
const renderCodeBlock: RenderRules["fence"] = (node, _children, _parent, styles) => (
  <Text key={node.key} selectable style={styles.codeBlock as TextStyle}>
    {node.content.replace(/\n$/, "")}
  </Text>
);
const rules: RenderRules = {
  textgroup: (node, children) => (
    <Text key={node.key} selectable style={textStyle}>
      {children}
    </Text>
  ),
  image: (node) => (
    <Text key={node.key} selectable style={{ color: colors.muted }}>
      {node.attributes.alt ? `[Image: ${node.attributes.alt}]` : "[Image]"}
    </Text>
  ),
  code_block: renderCodeBlock,
  fence: renderCodeBlock,
};

export function AssistantResponse({ content }: { content: string }) {
  const [linkError, setLinkError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [speechOffered] = useState(() => isSpeechSupported());
  const onLinkPress = useCallback((url: string) => {
    if (!isSafeAssistantUrl(url)) return false;
    setLinkError("");
    void Linking.openURL(url).catch((error) =>
      setLinkError(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }, []);
  // A new reply elsewhere takes the voice: stop this one when it unmounts.
  useEffect(() => () => stopSpeaking(), []);
  const toggleSpeech = useCallback(() => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    stopSpeaking();
    speakMarkdown(content, () => setSpeaking(false));
    setSpeaking(true);
  }, [content, speaking]);
  return (
    <>
      <Markdown
        markdownit={assistantMarkdown}
        style={style}
        rules={rules}
        onLinkPress={onLinkPress}
      >
        {content}
      </Markdown>
      {speechOffered && (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 2 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={speaking ? "Stop reading aloud" : "Read reply aloud"}
            onPress={toggleSpeech}
            style={({ pressed }) => ({
              width: 32,
              height: 32,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 16,
              backgroundColor: speaking ? "#FDE8E8" : pressed ? "#E2E4E7" : "transparent",
            })}
          >
            {speaking ? (
              <Square size={13} fill={colors.muted} strokeWidth={0} />
            ) : (
              <Volume2 size={17} strokeWidth={1.8} color={colors.muted} />
            )}
          </Pressable>
        </View>
      )}
      <ErrorNotice error={linkError} />
    </>
  );
}

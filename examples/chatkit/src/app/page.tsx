import ChatView from '@/app/components/ChatView';

export const dynamic = 'force-dynamic';

export default function Page() {
  const domainKey = process.env.NEXT_PUBLIC_CHATKIT_DOMAIN_KEY ?? 'local-dev';

  return (
    <ChatView
      title="Agents SDK + ChatKit"
      description="ChatKit React UI backed by a minimal ChatKit server implemented with the Agents SDK."
      apiUrl="/api/chatkit"
      domainKey={domainKey}
    />
  );
}

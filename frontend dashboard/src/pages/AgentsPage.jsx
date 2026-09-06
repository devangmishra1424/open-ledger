import React, { useState, useEffect } from 'react';
import GlassCard from '../components/GlassCard';
import { mockAgents } from '../data/mockData';
import { api } from '../services/api';
import { Bot, Cpu } from 'lucide-react';

const AgentsPage = () => {
  const [agents, setAgents] = useState(mockAgents);

  useEffect(() => {
    api.getAgents().then((data) => {
      if (data && data.length > 0) setAgents(data);
    });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
      <GlassCard style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Bot size={24} color="#a7c957" />
              Autonomous Financial Agent Fleet
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Real-time monitoring, model specs, throughput, and accuracy scores
            </p>
          </div>
          <span className="status-chip clean">
            <span className="status-dot" />
            {agents.filter(a => a.status === 'Active').length}/{agents.length} Agents Active & Healthy
          </span>
        </div>
      </GlassCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>
        {agents.map((agent) => (
          <GlassCard key={agent.id} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: '#232733', border: '1px solid rgba(255, 255, 255, 0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff' }}>
                  <Cpu size={20} />
                </div>
                <div>
                  <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff' }}>{agent.name}</h3>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{agent.role}</p>
                </div>
              </div>
              <span className="status-chip clean" style={{ fontSize: '11px' }}>
                {agent.status}
              </span>
            </div>

            <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              {agent.description}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', background: 'rgba(255, 255, 255, 0.04)', padding: '12px', borderRadius: '12px', border: '1px solid var(--border-glass)' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Accuracy</div>
                <div className="font-mono" style={{ fontSize: '16px', fontWeight: 700, color: '#a7c957' }}>{agent.accuracy}%</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Avg Latency</div>
                <div className="font-mono" style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff' }}>{agent.avgSpeed}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Processed</div>
                <div className="font-mono" style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff' }}>{agent.totalProcessed.toLocaleString()}</div>
              </div>
            </div>
          </GlassCard>
        ))}
      </div>
    </div>
  );
};

export default AgentsPage;

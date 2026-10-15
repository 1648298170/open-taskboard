import { Issue, STATUSES, Status } from '../api';

export function Board({ issues, onOpen, onDrop }: {
  issues: Issue[];
  onOpen: (id: string) => void;
  onDrop: (id: string, status: Status) => void;
}) {
  return (
    <main className="board">
      {STATUSES.map(status => {
        const list = issues.filter(i => i.status === status);
        return (
          <section key={status} className="column" data-status={status}
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
            onDragLeave={e => e.currentTarget.classList.remove('drag-over')}
            onDrop={e => {
              e.preventDefault();
              e.currentTarget.classList.remove('drag-over');
              onDrop(e.dataTransfer.getData('text/plain'), status);
            }}>
            <h2>
              <span className={`dot ${status}`} />{status}
              <span className="count">{list.length}</span>
            </h2>
            <div className="cards">
              {list.filter(i => !i.parentId).map(top => (
                <div key={top.id}>
                  <Card issue={top} onOpen={onOpen} />
                  {issues.filter(c => c.parentId === top.id).map(child =>
                    <Card key={child.id} issue={child} child onOpen={onOpen} />)}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function Card({ issue, child, onOpen }: { issue: Issue; child?: boolean; onOpen: (id: string) => void }) {
  return (
    <article className="card" data-status={issue.status}
      style={child ? { marginLeft: 18 } : undefined}
      draggable
      onClick={() => onOpen(issue.id)}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', issue.id);
        e.currentTarget.classList.add('dragging');
      }}
      onDragEnd={e => e.currentTarget.classList.remove('dragging')}>
      <div className="card-title">{child ? '└ ' : ''}{issue.title}</div>
      <div className="card-meta">
        <span className={`badge ${issue.priority}`}>{issue.priority}</span>
        {issue.branch && <span className="badge branch">⟂ {issue.branch}</span>}
        <span>#{issue.id}</span>
      </div>
    </article>
  );
}

module.exports = (robot) => {
  robot.on('issues.labeled', async context => {
    // context.log(context) // debug
    // https://medium.com/javascript-inside/safely-accessing-deeply-nested-values-in-javascript-99bf72a0855a
    const safeGet = (p, o) => p.reduce((xs, x) => (xs && xs[x]) ? xs[x] : null, o)

    // Load config from .github/myapp.yml in the repository
    // e.g.:
    // bug:
    //   repo:
    //     new tickets: todo
    //     help: todo
    //
    // That will add issues labeled with 'bug' to the 'todo'
    // columns of the 'new tickets' and 'help' repository projects.
    const config = await context.config('probot-labelboard.yml')

    const labels = Object.keys(config) // labels we care about
    const label = context.payload.label.name
    if (labels.includes(label)) {
      // debugger; // statements don't work? GHE_HOST=ghe-local.test node debug node_modules/probot/bin/probot-run.js -a...

      // get all repo projects from API, because we need the ids
      const repoProjectsRes = await context.github.projects.getRepoProjects(
        { owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name })

      // get all columns for all projects
      const columnsRes = await Promise.all(repoProjectsRes.data.map((p) => {
        return context.github.projects.getProjectColumns({project_id: p.id})
      }))

      // zip the projects and columns maps together, with project names as keys and {column_name: column_id, ...} as value
      // e.g. {"tickets":{"todo":331,"done":332},"meh":{"shrug":333}}
      const repoProjectColumnIds = repoProjectsRes.data.map((e, i) => {
        return {
          [e.name]: columnsRes[i]['data'].map((c) => {
            return {[c.name]: c.id}
          }).reduce((acc, e) => Object.assign(acc, e), {})
        }
      }).reduce((acc, e) => Object.assign(acc, e), {})

      // graphql to get cards the issue is in. REST requires iterating over every card.
      const graphql = require('request')
      const graphqlReq = {
        uri: 'https://' + (process.env.GHE_HOST || 'api.github.com') + (process.env.GHE_HOST ? '/api/graphql' : '/graphql'),
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + context.github.auth.token,
          'content-type': 'application/json',
          'user-agent': 'probot-labelboard'
        },
        json: {
          query: 'query {' +
            'repositoryOwner(login: "' + context.payload.repository.owner.login + '") {' +
              'repository(name: "' + context.payload.repository.name + '") {' +
                'issue(number: ' + context.payload.issue.number + ') {' +
                  'projectCards(first: 30){ edges{ node{' +
                        'resourcePath column{ project{name number } resourcePath name }}}}}}}}'
        }
      }
      const graphqlQuery = () => {
        return new Promise((resolve) => {
          graphql.post(graphqlReq, (err, res, body) => {
            if (err) {
              resolve([])
            } else {
              resolve(safeGet(['data', 'repositoryOwner', 'repository', 'issue', 'projectCards', 'edges'], body))
            }
          })
        })
      }
      const existingColumns = await graphqlQuery() || []
      const existingProjectsColumnId = existingColumns.map((edge) => { // {project1: columnID1, project2: columnId2}
        return {[edge.node.column.project.name]: edge.node.resourcePath.split('-').slice(-1)[0]}
      }).reduce((acc, e) => Object.assign(acc, e), {})

      // Find which repo-project-column the tag should be added to
      const targetRepoProjects = config[label]['repo']
      if (targetRepoProjects) {
        // for each project, see which column this label should go to
        Object.keys(targetRepoProjects).forEach((project) => {
          const targetColumn = targetRepoProjects[project]
          if (Object.keys(existingProjectsColumnId).includes(project)) {
            // attempt moving the card
            context.github.projects.moveProjectCard(
              { id: existingProjectsColumnId[project],
                position: 'top',
                column_id: repoProjectColumnIds[project][targetColumn]
              })
          } else {
            // create new card
            context.github.projects.createProjectCard(
              { column_id: repoProjectColumnIds[project][targetColumn],
                content_id: context.payload.issue.id,
                content_type: 'Issue'
              })
          }
        })
      }
    } // end if ( labels.includes(label) )
  })
}

using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using System.Data;
using System.Text.RegularExpressions;

namespace mssql_api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class SqlController : ControllerBase
{
    private readonly IConfiguration _config;

    public SqlController(IConfiguration config)
    {
        _config = config;
    }

    // GET api/sql/version
    [HttpGet("version")]
    public async Task<IActionResult> GetVersion()
    {
        var connStr = _config.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connStr))
            return BadRequest(new { error = "Connection string 'DefaultConnection' not configured in appsettings.json" });

        try
        {
            await using var conn = new SqlConnection(connStr);
            await conn.OpenAsync();
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT @@VERSION";
            var result = await cmd.ExecuteScalarAsync();
            return Ok(new { version = result?.ToString() });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // GET api/sql/tables
    [HttpGet("tables")]
    public async Task<IActionResult> GetTables()
    {
        var connStr = _config.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connStr))
            return BadRequest(new { error = "Connection string 'DefaultConnection' not configured in appsettings.json" });

        try
        {
            await using var conn = new SqlConnection(connStr);
            await conn.OpenAsync();
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME";
            var tables = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                var schema = reader.GetString(0);
                var name = reader.GetString(1);
                tables.Add(new { schema, name });
            }

            return Ok(tables);
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // POST api/sql/execute
    [HttpPost("execute")]
    public async Task<IActionResult> ExecuteSql([FromBody] SqlExecuteRequest request)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.Sql))
            return BadRequest(new { error = "Request body must contain 'sql' property with a SQL statement." });

        var connStr = _config.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connStr))
            return BadRequest(new { error = "Connection string 'DefaultConnection' not configured in appsettings.json" });

        try
        {
            await using var conn = new SqlConnection(connStr);
            await conn.OpenAsync();
            // detect sp_help usage to call it as a stored procedure and handle multiple result sets
            var sqlTrim = request.Sql.TrimStart();
            var spHelpMatch = Regex.Match(sqlTrim, "^(?:exec\\s+)?sp_help\\s+(?:'([^']+)'|\"([^\"]+)\"|(\\S+))", RegexOptions.IgnoreCase);

            if (spHelpMatch.Success)
            {
                var tableName = spHelpMatch.Groups[1].Success ? spHelpMatch.Groups[1].Value :
                                spHelpMatch.Groups[2].Success ? spHelpMatch.Groups[2].Value :
                                spHelpMatch.Groups[3].Success ? spHelpMatch.Groups[3].Value : null;

                await using var spCmd = conn.CreateCommand();
                spCmd.CommandText = "sp_help";
                spCmd.CommandType = CommandType.StoredProcedure;
                spCmd.Parameters.AddWithValue("@objname", tableName ?? (object)DBNull.Value);

                var resultSets = new List<object>();
                await using var reader = await spCmd.ExecuteReaderAsync();
                do
                {
                    var fieldCount = reader.FieldCount;
                    var columns = new string[fieldCount];
                    for (int i = 0; i < fieldCount; i++) columns[i] = reader.GetName(i);

                    var rows = new List<Dictionary<string, object?>>();
                    while (await reader.ReadAsync())
                    {
                        var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                        for (int i = 0; i < fieldCount; i++)
                        {
                            var val = await reader.IsDBNullAsync(i) ? null : reader.GetValue(i);
                            row[columns[i]] = val;
                        }
                        rows.Add(row);
                    }

                    resultSets.Add(new { columns, rows });
                } while (await reader.NextResultAsync());

                return Ok(new { resultSets });
            }

            await using var cmd = conn.CreateCommand();
            cmd.CommandText = request.Sql;

            sqlTrim = request.Sql.TrimStart();
            if (sqlTrim.StartsWith("select", StringComparison.OrdinalIgnoreCase) || sqlTrim.StartsWith("with", StringComparison.OrdinalIgnoreCase))
            {
                var resultSets = new List<object>();
                await using var reader = await cmd.ExecuteReaderAsync();
                do
                {
                    var fieldCount = reader.FieldCount;
                    var columns = new string[fieldCount];
                    for (int i = 0; i < fieldCount; i++) columns[i] = reader.GetName(i);

                    var rows = new List<Dictionary<string, object?>>();
                    while (await reader.ReadAsync())
                    {
                        var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                        for (int i = 0; i < fieldCount; i++)
                        {
                            var val = await reader.IsDBNullAsync(i) ? null : reader.GetValue(i);
                            row[columns[i]] = val;
                        }
                        rows.Add(row);
                    }

                    resultSets.Add(new { columns, rows });
                } while (await reader.NextResultAsync());

                return Ok(new { resultSets });
            }
            else
            {
                var affected = await cmd.ExecuteNonQueryAsync();
                    // Return plain text with the result for non-SELECT commands
                    return Content($"Linhas afetadas: {affected}", "text/plain");
            }
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // POST api/sql/query
    [HttpPost("query")]
    public async Task<IActionResult> QuerySql([FromBody] SqlExecuteRequest request)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.Sql))
            return BadRequest(new { error = "Request body must contain 'sql' property with a SQL statement." });

        var sqlTrim = request.Sql.TrimStart();
        if (!(sqlTrim.StartsWith("select", StringComparison.OrdinalIgnoreCase) || sqlTrim.StartsWith("with", StringComparison.OrdinalIgnoreCase)))
            return BadRequest(new { error = "Only SELECT queries are allowed on this endpoint." });

        var connStr = _config.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connStr))
            return BadRequest(new { error = "Connection string 'DefaultConnection' not configured in appsettings.json" });

        try
        {
            await using var conn = new SqlConnection(connStr);
            await conn.OpenAsync();
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = request.Sql;

            var resultSets = new List<object>();
            await using var reader = await cmd.ExecuteReaderAsync();
            do
            {
                var fieldCount = reader.FieldCount;
                var columns = new string[fieldCount];
                for (int i = 0; i < fieldCount; i++) columns[i] = reader.GetName(i);

                var rows = new List<object?[]>();
                while (await reader.ReadAsync())
                {
                    var row = new object?[fieldCount];
                    for (int i = 0; i < fieldCount; i++)
                    {
                        row[i] = await reader.IsDBNullAsync(i) ? null : reader.GetValue(i);
                    }
                    rows.Add(row);
                }

                resultSets.Add(new { columns, rows });
            } while (await reader.NextResultAsync());

            return Ok(new { resultSets });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }
}

public class SqlExecuteRequest
{
    public string Sql { get; set; } = string.Empty;
}
